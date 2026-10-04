package org.pimobile.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Foreground service owning the Node bridge process.
 * Layout under filesDir:
 *   usr/      termux prefix (bin, lib, etc.)
 *   home/     HOME ($HOME/.pi/agent for auth.json, $HOME/.pi-mobile for bridge state)
 *   work/     default agent working directory
 *   runtime/  server.mjs + node_modules
 *   tmp/      TMPDIR
 *
 * Exactly one node process runs per service. Every Activity start calls
 * startForegroundService(); that must not restart a running bridge, because
 * a restart interrupts the agent's running tool calls and pi-durable allows a
 * single storage owner. A supervisor restarts node with backoff if it dies.
 */
public final class PiService extends Service {

    private static final String CHANNEL = "pi-runtime";
    private static final long STOP_GRACE_MS = 8000;

    private final Object lock = new Object();
    private Process nodeProcess;
    private Thread supervisor;
    private volatile boolean stopping;
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundWithNotification();
        acquireWakeLock();
        synchronized (lock) {
            if (supervisor != null && supervisor.isAlive()) return START_STICKY; // already running
            stopping = false;
            supervisor = new Thread(this::superviseNode, "pi-supervisor");
            supervisor.start();
        }
        return START_STICKY;
    }

    /** Install if needed, then keep one node process alive (restart with backoff). */
    private void superviseNode() {
        try {
            if (!RuntimeInstaller.isInstalled(this)) {
                terminateOrphanServer(); // must not run while its files are replaced
                RuntimeInstaller.install(this);
            }
        } catch (Exception e) {
            logError("install failed", e);
            stopSelf();
            return;
        }
        long backoff = 1000;
        while (!stopping) {
            long started = System.currentTimeMillis();
            Process p;
            try {
                p = startNode();
            } catch (Exception e) {
                logError("node start failed", e);
                p = null;
            }
            if (p != null) {
                synchronized (lock) { nodeProcess = p; }
                try {
                    int code = p.waitFor();
                    if (!stopping) logError("node exited " + code + "; restarting", null);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
                synchronized (lock) { if (nodeProcess == p) nodeProcess = null; }
            }
            if (stopping) return;
            // a process that ran for a while gets a quick restart again
            if (System.currentTimeMillis() - started > 60_000) backoff = 1000;
            try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
            backoff = Math.min(backoff * 2, 30_000);
        }
    }

    private Process startNode() throws IOException {
        File files = getFilesDir();
        File prefix = new File(files, "usr");
        File home = new File(files, "home");
        File runtime = new File(files, "runtime");

        Map<String, String> env = new HashMap<>();
        env.put("HOME", home.getAbsolutePath());
        env.put("PREFIX", prefix.getAbsolutePath());
        env.put("TMPDIR", new File(files, "tmp").getAbsolutePath());
        env.put("PATH", prefix.getAbsolutePath() + "/bin:/system/bin:/system/xbin");
        env.put("LD_LIBRARY_PATH", prefix.getAbsolutePath() + "/lib");
        env.put("TERM", "dumb");
        env.put("LANG", "C.UTF-8");
        env.put("PI_WORKDIR", new File(files, "work").getAbsolutePath());
        env.put("PI_SHELL", new File(prefix, "bin/bash").getAbsolutePath());
        // Termux-built openssl hardcodes /data/data/com.termux paths — point at ours.
        env.put("OPENSSL_CONF", new File(prefix, "etc/tls/openssl.cnf").getAbsolutePath());
        env.put("SSL_CERT_FILE", new File(prefix, "etc/tls/cert.pem").getAbsolutePath());

        // a stale port file would make the UI load a dead bridge address
        new File(new File(home, ".pi-mobile"), "port").delete();

        String node = new File(prefix, "bin/node").getAbsolutePath();
        String server = new File(runtime, "server.mjs").getAbsolutePath();

        List<String> cmd = new ArrayList<>();
        cmd.add(node);
        cmd.add(server);
        try {
            return spawn(cmd, env, home);
        } catch (IOException directFailed) {
            // targetSdk >= 29 on Android 10+: exec of app-private files is
            // blocked -> run the ELF through the system dynamic linker.
            cmd.set(0, "/system/bin/linker64");
            cmd.add(1, node);
            return spawn(cmd, env, home);
        }
    }

    private Process spawn(List<String> cmd, Map<String, String> env, File cwd) throws IOException {
        File log = new File(getFilesDir(), "log/node.log");
        log.getParentFile().mkdirs();
        rotateLog(log);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().putAll(env);
        pb.directory(cwd);
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        return pb.start();
    }

    private static void rotateLog(File log) {
        if (log.length() > 4L * 1024 * 1024) {
            File old = new File(log.getPath() + ".1");
            old.delete();
            log.renameTo(old);
        }
    }

    /**
     * Graceful stop: SIGTERM (server.mjs closes the harness and releases its
     * storage lock), wait, then kill. The pid comes from server.mjs's lock file.
     */
    private void stopNode() {
        Process p;
        synchronized (lock) { p = nodeProcess; }
        if (p == null) return;
        int pid = readServerPid();
        if (pid > 0) {
            try { android.os.Process.sendSignal(pid, 15); } catch (Exception ignored) { }
        } else {
            p.destroy();
        }
        try {
            if (!p.waitFor(STOP_GRACE_MS, TimeUnit.MILLISECONDS)) {
                p.destroyForcibly();
                p.waitFor(2000, TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException ie) {
            p.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }

    /** A node left over from a killed app process (same uid) still owns the storage. */
    private void terminateOrphanServer() {
        int pid = readServerPid();
        if (pid <= 0 || !isServerProcess(pid)) return;
        android.os.Process.sendSignal(pid, 15);
        for (int i = 0; i < 80 && isServerProcess(pid); i++) {
            try { Thread.sleep(100); } catch (InterruptedException ie) { return; }
        }
        if (isServerProcess(pid)) android.os.Process.sendSignal(pid, 9);
    }

    private static boolean isServerProcess(int pid) {
        try (FileInputStream in = new FileInputStream("/proc/" + pid + "/cmdline")) {
            byte[] b = new byte[4096];
            int n = in.read(b);
            return n > 0 && new String(b, 0, n, "UTF-8").contains("server.mjs");
        } catch (Exception e) {
            return false;
        }
    }

    private int readServerPid() {
        File f = new File(new File(new File(getFilesDir(), "home"), ".pi-mobile"), "server.lock");
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) Math.min(f.length(), 4096)];
            int n = in.read(b);
            Matcher m = Pattern.compile("\"pid\"\\s*:\\s*(\\d+)").matcher(new String(b, 0, Math.max(n, 0), "UTF-8"));
            return m.find() ? Integer.parseInt(m.group(1)) : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    private void logError(String msg, Exception e) {
        android.util.Log.e("PiService", msg, e);
        try {
            File f = new File(getFilesDir(), "log/service-error.txt");
            f.getParentFile().mkdirs();
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
                w.write(new java.util.Date() + " " + msg + (e != null ? ": " + e : "") + "\n");
            }
        } catch (IOException ignored) { }
    }

    private void startForegroundWithNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL, "pi runtime", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE);
        Notification n;
        if (Build.VERSION.SDK_INT >= 26) {
            n = new Notification.Builder(this, CHANNEL)
                    .setContentTitle("pi mobile")
                    .setContentText("agent runtime running")
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentIntent(pi)
                    .build();
        } else {
            n = new Notification.Builder(this)
                    .setContentTitle("pi mobile")
                    .setContentText("agent runtime running")
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentIntent(pi)
                    .build();
        }
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(1, n);
        }
    }

    private synchronized void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pimobile:runtime");
            wakeLock.setReferenceCounted(false); // repeated starts must not stack holds
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        Thread sup;
        synchronized (lock) { sup = supervisor; supervisor = null; }
        stopNode();
        if (sup != null) sup.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
