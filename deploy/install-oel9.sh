#!/usr/bin/env bash
set -euo pipefail

service_user=primavera
app_dir=/opt/primavera-agentica
config_dir=/etc/primavera-agentica
upload_dir=/home/opc
public_host=${PUBLIC_HOST:?Set PUBLIC_HOST to the DNS name or IP used to serve the application}
unifier_parent_origin=${UNIFIER_PARENT_ORIGIN:?Set UNIFIER_PARENT_ORIGIN, for example https://your-unifier-host.example.com}

if ! command -v envsubst >/dev/null 2>&1; then
  echo "envsubst is required. Install the gettext package first." >&2
  exit 1
fi

if [[ "$public_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  certificate_san="IP:$public_host"
else
  certificate_san="DNS:$public_host"
fi

if ! id "$service_user" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$app_dir" --shell /sbin/nologin "$service_user"
fi

release_dir=$(mktemp -d /opt/primavera-release.XXXXXX)
tar -xzf "$upload_dir/primavera-agentica-release.tgz" -C "$release_dir"
chown -R "$service_user:$service_user" "$release_dir"
runuser -u "$service_user" -- env npm_config_cache="$release_dir/.npm-cache" npm ci --omit=dev --prefix "$release_dir"

if [ -d "$app_dir" ]; then
  mv "$app_dir" "/opt/primavera-agentica.backup.$(date +%Y%m%d%H%M%S)"
fi
mv "$release_dir" "$app_dir"
install -d -o "$service_user" -g "$service_user" -m 0750 "$app_dir/data"

install -d -o root -g "$service_user" -m 0750 "$config_dir"
install -o root -g "$service_user" -m 0640 "$upload_dir/primavera-agentica.env" "$config_dir/primavera-agentica.env"
install -o root -g root -m 0644 "$upload_dir/primavera-agentica.service" /etc/systemd/system/primavera-agentica.service

install -d -o root -g nginx -m 0750 /etc/nginx/tls
if [ ! -f /etc/nginx/tls/primavera-agentica.crt ]; then
  openssl req -x509 -nodes -newkey rsa:3072 -days 30 \
    -keyout /etc/nginx/tls/primavera-agentica.key \
    -out /etc/nginx/tls/primavera-agentica.crt \
    -subj "/CN=$public_host" \
    -addext "subjectAltName=$certificate_san"
fi
chown root:nginx /etc/nginx/tls/primavera-agentica.key /etc/nginx/tls/primavera-agentica.crt
chmod 0640 /etc/nginx/tls/primavera-agentica.key
chmod 0644 /etc/nginx/tls/primavera-agentica.crt
export PUBLIC_HOST="$public_host" UNIFIER_PARENT_ORIGIN="$unifier_parent_origin"
envsubst '${PUBLIC_HOST} ${UNIFIER_PARENT_ORIGIN}' < "$upload_dir/nginx-primavera-agentica.conf.template" > /etc/nginx/conf.d/primavera-agentica.conf
chown root:root /etc/nginx/conf.d/primavera-agentica.conf
chmod 0644 /etc/nginx/conf.d/primavera-agentica.conf

setsebool -P httpd_can_network_connect 1
nginx -t
systemctl daemon-reload
systemctl enable --now primavera-agentica.service
systemctl enable --now nginx.service
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload

systemctl --no-pager --full status primavera-agentica.service
systemctl --no-pager --full status nginx.service
curl --fail --silent --show-error http://127.0.0.1:3000/api/auth/session
curl --insecure --fail --silent --show-error https://127.0.0.1/api/auth/session
