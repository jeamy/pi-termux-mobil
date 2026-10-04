#!/usr/bin/env bash
# Start pi-serverd (remote session daemon) on this machine.
cd "$(dirname "${BASH_SOURCE[0]}")/runtime" || exit 1
export PI_WORKDIR="${PI_WORKDIR:-/home/lux/programming}"
exec node pi-serverd.mjs
