#!/bin/sh
# One-shot, run as root by the exec-keys service: creates the ssh keys once (a re-run keeps the existing ones, so the
# pinned host key never changes) and fixes owners and modes every time.
#   /host   (volume exec-host, mounted read-only into exec)   host key pair, authorized_keys
#   /client (volume exec-client, mounted read-only into control)  client key pair and a copy of the host public key
# Everything belongs to uid 1000, which is the user both exec's sshd (agent) and control run as.
set -eu
umask 077
host=/host
client=/client

[ -s "$host/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N "" -C rei-exec-host -f "$host/ssh_host_ed25519_key"
[ -s "$client/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C rei-control -f "$client/id_ed25519"

# Write a file from stdin through a temporary name, so a reader never sees half of it. $1 mode, $2 destination.
publish() {
  cat > "$2.tmp"
  chmod "$1" "$2.tmp"
  chown 1000:1000 "$2.tmp"
  mv -f "$2.tmp" "$2"
}

# The public halves are always derived from the private ones.
ssh-keygen -y -f "$host/ssh_host_ed25519_key" | publish 0644 "$host/ssh_host_ed25519_key.pub"
ssh-keygen -y -f "$client/id_ed25519" | publish 0644 "$client/id_ed25519.pub"
publish 0644 "$host/authorized_keys" < "$client/id_ed25519.pub"
publish 0644 "$client/host_ed25519_key.pub" < "$host/ssh_host_ed25519_key.pub"
chmod 0600 "$host/ssh_host_ed25519_key" "$client/id_ed25519"
chown 1000:1000 "$host/ssh_host_ed25519_key" "$client/id_ed25519"
# A fingerprint is not a secret; it lets you compare against what a client pinned.
echo "exec host key: $(ssh-keygen -lf "$host/ssh_host_ed25519_key.pub" | cut -d' ' -f2)"
