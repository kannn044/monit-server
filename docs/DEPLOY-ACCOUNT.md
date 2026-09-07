# A shared account for adding servers (Rocky Linux 9)

For a team that needs to run `deploy-agent.sh` on the central server without
being handed root.

## Do you need this?

Probably not for a single host. The dashboard's install link — Groups →
**Add a server**, or **Install** on a row — gives one line to run on the machine
being monitored, with no account on the central server at all. This account is
worth creating when you are onboarding hosts in batches, or when a target cannot
reach the dashboard's address and has to be pushed to over ssh.

**One shared login means the audit trail stops at the door.** `/var/log/secure`
will record that `monitdeploy` connected, not which of your colleagues it was,
and a password known to five people cannot be revoked for one of them. If that
matters, make individual accounts and put them all in the `monitdeploy` group —
every step below is the same except `useradd`, and the group is what actually
grants access.

## What the account needs

* to read the deploy directory,
* to ssh out to the machines being monitored.

That is all. It needs **no sudo on the central server** — every privileged step
in `deploy-agent.sh` runs on the target, through that target's own sudo. It must
**not** be able to read `.env`, which holds the database password and the JWT
signing secret.

---

## 1. Move the checkout somewhere shared

A checkout under `/home/gdata/` is unreadable to anyone else no matter what you
do to the files, because the home directory itself is `0700`. That, not the
script, is what has been forcing `sudo -i`.

```bash
sudo mv /home/gdata/monit-server /opt/monit-deploy
sudo ln -s /opt/monit-deploy /home/gdata/monit-server   # keep old paths working
```

## 2. Create the group and the account

```bash
sudo groupadd -f monitdeploy
sudo useradd -m -s /bin/bash -g monitdeploy -c 'agent deployment' monitdeploy
sudo passwd monitdeploy
```

Rocky 9 checks the password against `pw_quality`. Run as root, `passwd` will warn
"BAD PASSWORD" on a weak one and still accept it — do not take the offer. Use a
long passphrase; this account can reach every machine you monitor.

For individual logins instead of one shared one:

```bash
sudo useradd -m -s /bin/bash -G monitdeploy somchai
```

## 3. Grant read access, and keep `.env` out of it

```bash
sudo chgrp -R monitdeploy /opt/monit-deploy
sudo chmod -R g+rX /opt/monit-deploy
sudo chown root:root /opt/monit-deploy/.env
sudo chmod 600 /opt/monit-deploy/.env
```

Check both halves — the second command must fail:

```bash
sudo -u monitdeploy head -1 /opt/monit-deploy/deploy-agent.sh   # -> #!/usr/bin/env bash
sudo -u monitdeploy cat /opt/monit-deploy/.env                  # -> Permission denied
```

`deploy-agent.sh` only ever read `.env` to guess the dashboard's port and
sub-path. Once **Settings → Address agents connect to** is set, the dashboard
writes `-U` into the command for you and the file is not needed at all.

## 4. Let it log in with a password

Rocky 9 reads `/etc/ssh/sshd_config.d/*.conf` **before** the main file, and the
first setting wins — so a cloud image that dropped `PasswordAuthentication no`
into that directory overrides the `yes` you can see in `sshd_config`. Do not
read the file; ask sshd what it actually resolved:

```bash
sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin|usepam)'
```

If it says `passwordauthentication no` and you want passwords for this account
only, add a `Match` block rather than opening it up for everyone:

```bash
sudo tee /etc/ssh/sshd_config.d/60-monitdeploy.conf >/dev/null <<'EOF'
Match User monitdeploy
    PasswordAuthentication yes
EOF
sudo sshd -t && sudo systemctl reload sshd
```

`sshd -t` checks the config before the reload; skipping it is how people lock
themselves out. Keep your current session open until a second one connects.

Restricting where it may connect from is worth the extra line:

```
Match User monitdeploy Address 10.1.0.0/16,10.1.1.0/24
    PasswordAuthentication yes
```

## 5. No sudo — on purpose

Do not add the account to `wheel`. If it is already there:

```bash
sudo gpasswd -d monitdeploy wheel
sudo -u monitdeploy sudo -n true    # expect: a password prompt or "not allowed"
```

## 6. Reaching the targets

`deploy-agent.sh` opens one ssh connection and reuses it, so a password-only
target is asked once per run. Keys are less typing:

```bash
sudo -u monitdeploy -H ssh-keygen -t ed25519 -N '' -f ~monitdeploy/.ssh/id_ed25519
sudo -u monitdeploy -H ssh-copy-id adminmop@10.1.0.222
```

Be deliberate about this: a key in a **shared** account is a key anyone with the
account's password can use, on every host you copy it to. With individual
accounts each person gets their own, which is the version that can be revoked.

## 7. Use it

```bash
ssh monitdeploy@10.1.1.171
cd /opt/monit-deploy
./deploy-agent.sh adminmop@10.1.0.222 -i mysql-cluster-mysqld2 \
  -k sk_agent_… -U http://10.1.1.171:8080
```

`-i` and `-k` come from the dashboard when you register the server; `-U` is the
address agents connect to, from Settings. The dashboard writes the whole line
for you — Groups → the server → **Or push it from the central server over ssh**.

## SELinux

Nothing here needs an SELinux change: no confined service reads these files, and
`/opt` is fine for a home-grown tool. Leave enforcing mode on. If you put the
checkout somewhere unusual and ssh starts refusing keys, the cause is normally
file context on `~/.ssh` — `restorecon -Rv ~monitdeploy/.ssh` fixes it.

## Undo

```bash
sudo userdel -r monitdeploy
sudo rm -f /etc/ssh/sshd_config.d/60-monitdeploy.conf
sudo sshd -t && sudo systemctl reload sshd
```
