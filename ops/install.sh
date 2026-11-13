#!/bin/sh
# Install or render the launchd agents for On the Record. See docs/deployment.md.
set -eu
exec node "$(dirname "$0")/install.cjs" "$@"
