package org.pimobile.app;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Extracts the bundled runtime (Termux binaries + pi runtime) from assets
 * into the app's private files directory using the system toybox tar.
 *
 * Archives are streamed into tar's stdin (no temporary copy of ~170 MB).
 * usr/ and runtime/ are replaced as a whole on upgrade, so files removed from
 * a newer bundle do not linger; home/ and work/ (user data) are never touched.
 */
final class RuntimeInstaller {

    static final String STAMP_NAME = ".runtime-version";
    static final int RUNTIME_VERSION = 46;

    private RuntimeInstaller() {}

    static boolean isInstalled(Context ctx) {
        File stamp = new File(ctx.getFilesDir(), STAMP_NAME);
        if (!stamp.isFile()) return false;
        try {
            byte[] b = new byte[(int) stamp.length()];
            try (InputStream in = new java.io.FileInputStream(stamp)) {
                int off = 0;
                while (off < b.length) {
                    int n = in.read(b, off, b.length - off);
                    if (n < 0) break;
                    off += n;
                }
            }
            return new String(b, "UTF-8").trim().equals(payloadStamp(ctx));
        } catch (Exception e) {
            return false;
        }
    }

    private static String payloadStamp(Context ctx) throws IOException {
        try (InputStream in = ctx.getAssets().open("payload.sha256")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[128];
            int n;
            while ((n = in.read(buffer)) >= 0) bytes.write(buffer, 0, n);
            String hash = bytes.toString("UTF-8").trim();
            if (!hash.matches("[0-9a-f]{64}")) throw new IOException("invalid payload fingerprint");
            return RUNTIME_VERSION + ":" + hash;
        }
    }

    static void install(Context ctx) throws IOException, InterruptedException {
        File files = ctx.getFilesDir();
        AssetManager am = ctx.getAssets();

        // invalidate first: an interrupted install must not look complete
        new File(files, STAMP_NAME).delete();
        removeTree(new File(files, "usr"));
        removeTree(new File(files, "runtime"));

        extractTarAsset(am, files, "rootfs.bin");
        extractTarAsset(am, files, "runtime.bin");

        new File(files, "tmp").mkdirs();
        new File(files, "home").mkdirs();
        new File(files, "work").mkdirs();

        File stamp = new File(files, STAMP_NAME);
        File tmpStamp = new File(files, STAMP_NAME + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmpStamp)) {
            out.write(payloadStamp(ctx).getBytes("UTF-8"));
            out.getFD().sync();
        }
        if (!tmpStamp.renameTo(stamp)) throw new IOException("could not write " + stamp);
        removeTree(new File(ctx.getCacheDir(), "extract")); // leftovers of older versions
    }

    private static void extractTarAsset(AssetManager am, File dest, String name)
            throws IOException, InterruptedException {
        Process p = new ProcessBuilder("/system/bin/tar", "-xzf", "-", "-C", dest.getAbsolutePath())
                .redirectErrorStream(true).start();
        // drain tar's output concurrently so it can never block on a full pipe
        ByteArrayOutputStream log = new ByteArrayOutputStream();
        Thread drain = new Thread(() -> {
            byte[] b = new byte[8192];
            try (InputStream in = p.getInputStream()) {
                int n;
                while ((n = in.read(b)) >= 0) if (log.size() < 16_000) log.write(b, 0, n);
            } catch (IOException ignored) { }
        }, "tar-log");
        drain.start();
        try (InputStream in = am.open(name); OutputStream out = p.getOutputStream()) {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
        }
        int code = p.waitFor();
        drain.join(2000);
        if (code != 0) {
            String err = log.toString("UTF-8");
            android.util.Log.w("PiService", "tar exited " + code + " for " + name + ": " + err);
            // toybox tar exits non-zero on dangling symlinks (harmless) — only
            // treat it as failure when expected files are missing
            if (!expectedFilesPresent(dest, name)) {
                throw new IOException("tar failed (" + code + ") for " + name + ": " + err);
            }
        }
    }

    private static boolean expectedFilesPresent(File dest, String name) {
        if ("rootfs.bin".equals(name)) return new File(dest, "usr/bin/node").isFile();
        if ("runtime.bin".equals(name)) return new File(dest, "runtime/server.mjs").isFile();
        return true;
    }

    /** rm -rf without following symlinks (the rootfs contains links into lib/). */
    private static void removeTree(File f) throws IOException, InterruptedException {
        if (!f.exists() && !isSymlink(f)) return;
        Process p = new ProcessBuilder("/system/bin/rm", "-rf", f.getAbsolutePath())
                .redirectErrorStream(true).start();
        p.getInputStream().close();
        if (p.waitFor() != 0 && f.exists()) throw new IOException("could not remove " + f);
    }

    private static boolean isSymlink(File f) {
        try {
            return !f.getCanonicalPath().equals(f.getAbsolutePath());
        } catch (IOException e) {
            return false;
        }
    }
}
