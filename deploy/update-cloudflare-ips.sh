#!/usr/bin/env bash
set -euo pipefail

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsS https://www.cloudflare.com/ips-v4 -o "$tmp_dir/v4"
curl -fsS https://www.cloudflare.com/ips-v6 -o "$tmp_dir/v6"
python3 - "$tmp_dir/v4" "$tmp_dir/v6" > "$tmp_dir/allow.conf" <<'PY'
import ipaddress
import pathlib
import sys

ranges = []
for name in sys.argv[1:]:
    ranges.extend(pathlib.Path(name).read_text().splitlines())
if len(ranges) < 10:
    raise SystemExit('Cloudflare address list is incomplete')
for cidr in ranges:
    print(f'allow {ipaddress.ip_network(cidr, strict=True)};')
print('deny all;')
PY
install -m 0644 "$tmp_dir/allow.conf" /etc/nginx/cloudflare-allow.conf
nginx -t
systemctl reload nginx
