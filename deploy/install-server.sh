#!/usr/bin/env bash
# SLR Copilot — 服务器侧一次性安装脚本
# 在目标服务器以 root 运行:bash install-server.sh
# 幂等:可以多次执行
set -euo pipefail

DOMAIN="slr.yourai.asia"
APP_USER="slr"
APP_DIR="/opt/slr"
DATA_DIR="/var/lib/slr"
ENV_FILE="/etc/slr.env"
NGINX_SITE="/etc/nginx/sites-available/slr"
SYSTEMD_UNIT="/etc/systemd/system/slr.service"

# ---------- 0. preflight ----------
if [[ $EUID -ne 0 ]]; then
  echo "请以 root 运行" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 node,请先安装 Node 18+(本机已有 node 18.19.1)" >&2
  exit 1
fi

# ---------- 1. 系统用户 + 数据目录 ----------
if ! id "$APP_USER" >/dev/null 2>&1; then
  adduser --system --group --home "$APP_DIR" --shell /bin/bash "$APP_USER"
fi

mkdir -p "$APP_DIR"
mkdir -p "$DATA_DIR"/{uploads,pdfs,db,claude-home}
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"
chmod 700 "$DATA_DIR/claude-home"

# ---------- 2. Claude Code CLI ----------
if ! command -v claude >/dev/null 2>&1; then
  echo "==> 安装 Claude Code CLI"
  npm install -g @anthropic-ai/claude-code
fi
echo "==> Claude CLI: $(claude --version 2>/dev/null || echo unknown)"

# ---------- 3. /etc/slr.env(只在不存在时生成) ----------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> 生成 $ENV_FILE"
  SECRET="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3001
DATA_DIR=$DATA_DIR
DB_PATH=$DATA_DIR/db/slr.db
SESSION_SECRET=$SECRET
COOKIE_SECURE=true
CLAUDE_BIN=$(command -v claude)
CLAUDE_HOME=$DATA_DIR/claude-home
CLAUDE_MODEL_HEAVY=claude-sonnet-4-6
CLAUDE_MODEL_LIGHT=claude-haiku-4-5
EOF
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
else
  echo "==> $ENV_FILE 已存在,跳过"
fi

# ---------- 4. systemd ----------
if [[ -f "$APP_DIR/deploy/slr.service" ]]; then
  install -m 0644 "$APP_DIR/deploy/slr.service" "$SYSTEMD_UNIT"
  systemctl daemon-reload
fi

# ---------- 5. nginx ----------
if [[ -f "$APP_DIR/deploy/nginx.conf" ]]; then
  install -m 0644 "$APP_DIR/deploy/nginx.conf" "$NGINX_SITE"
  ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/slr"
  nginx -t
  systemctl reload nginx
fi

# ---------- 6. 装依赖 + 启动 ----------
if [[ -f "$APP_DIR/package.json" ]]; then
  echo "==> npm install"
  cd "$APP_DIR"
  runuser -u "$APP_USER" -- npm install --omit=dev
  systemctl enable --now slr || systemctl restart slr
  sleep 2
  systemctl status slr --no-pager -l | head -20 || true
fi

echo
echo "==> 完成。下一步:"
echo "  1) 切到 $APP_USER 用户跑一次 Claude OAuth 登录:"
echo "     sudo -u $APP_USER -H bash -c 'HOME=$DATA_DIR/claude-home claude login'"
echo "  2) DNS 生效后跑 Certbot:"
echo "     certbot --nginx -d $DOMAIN --redirect --non-interactive --agree-tos -m you@example.com"
echo "  3) 验证:curl -I https://$DOMAIN/"
