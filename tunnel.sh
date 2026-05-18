#!/bin/sh
# Opens a free public HTTPS tunnel pointing at your local Pulse server (port 8000).
# Used to satisfy Meta's HTTPS requirement for Facebook Login redirect URIs.
#
# No signup needed — uses localhost.run via SSH.
# Output: a unique URL like https://abc123.lhr.life that forwards to localhost:8000.
#
# Kill with Ctrl+C.

cd "$(dirname "$0")" || exit 1

# Make sure local server is running
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/ | grep -q 200; then
  echo "⚠️  Local server (localhost:8000) isn't responding."
  echo "    Open another terminal and run: sh run.sh"
  exit 1
fi

echo "Opening HTTPS tunnel to https://*.lhr.life …"
echo "Copy the URL printed below into your Meta App's redirect URIs."
echo ""
ssh -o StrictHostKeyChecking=accept-new \
    -o ServerAliveInterval=30 \
    -R 80:localhost:8000 nokey@localhost.run
