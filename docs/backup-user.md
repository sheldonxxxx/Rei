# Backups

Rei can back itself up every day, without stopping, to a folder on your machine. Turn it on in **Settings → Backups**. Restoring is one command.

A backup holds your account and settings, chats and sessions, the Library and its files, the memory and knowledge, the provider sign-ins, API keys and caller tokens saved in the gateway, and the files in Rei's own storage. It does not hold the search index (Rei rebuilds it), the agent workspace, the agent browser's logins, or the host's `.env` and `.secrets/`. [How it works](storage.md#backup-and-recovery) says why and what each failure costs.

## Set up

1. Choose a folder for the repository, on a different disk from Docker's volumes if you can, and make it writable by uid 1000 (the user Rei's control plane runs as):

   ```sh
   mkdir -p /path/to/rei-backups && chown 1000:1000 /path/to/rei-backups
   ```

   Docker Desktop and OrbStack share your own files with containers as you; there `chown` is not needed.

2. Put it in the stack's `.env` (`containers/.env`, or `~/.rei/.env` in an npm installation), then redeploy so the control plane mounts it:

   ```dotenv
   REI_BACKUP_DIR=/path/to/rei-backups
   ```

   Use an absolute path. Without it Settings → Backups says backups are not set up, and nothing can turn them on.

3. Open Settings → Backups and **Create repository**. Rei shows a password once. Save it somewhere that does not depend on Rei (a password manager), tick **I saved this password**, and confirm. Losing the password makes the repository unreadable; Rei keeps its own copy sealed in its database, but that is the database the backup protects.

   To use a repository that already exists (after a restore or a reinstall), choose **Connect existing** and enter its password.

4. Turn on **Back up every day**, pick the time (default 03:00, in your time zone), and choose how many daily, weekly and monthly backups to keep (default 7, 4 and 12). **Run now** starts one at once.

The page shows the last run, the next one, how many backups the repository holds and how big it is, and the history with the reason for any failed run. A failed run, or no success for 36 hours, sends you a notification, and `./rei doctor` warns when backups are off or stale. If the machine is off at the set time, the backup runs when it is next on.

**Forget repository** removes the saved password and turns backups off. It leaves the files in the folder.

## What to keep outside Rei

- The repository password.
- A copy of `containers/.env` and `containers/.secrets/` (`~/.rei/.env` and `~/.rei/.secrets/`). `secrets.env` holds `REI_EVENTS_KEY`; without it the restored event sources cannot decrypt their secrets. Keep these with the password, and refresh the copy whenever you change them.
- A copy of the repository folder somewhere else, if the machine's disk is all you have.

## See what you have

```sh
./rei backup snapshots
```

With Rei running this lists the repository it is using. After a disaster, or for another folder, name it and give the password:

```sh
REI_BACKUP_PASSWORD=... ./rei backup snapshots --repo /path/to/rei-backups
```

(Without `REI_BACKUP_PASSWORD` the command asks.) `--repo` defaults to `REI_BACKUP_DIR` from the stack's `.env`.

## Restore

```sh
./rei backup restore [--repo DIR] [--snapshot latest] [--only db,files,gateway,objects] [--prune-bucket] [--yes]
```

The command fetches the snapshot, checks every file against its manifest, shows what it is about to replace, and asks before it changes anything. It then stops Rei and the gateway, keeps copies of what it replaces in Docker volumes named `<volume>-pre-restore-<time>`, writes the database, the data files and the gateway's state, uploads the objects the bucket lacks, clears the search index so Rei rebuilds it from the restored history, starts the stack and runs `./rei doctor` and `containers/smoke-storage.sh`.

- `--snapshot` takes an id from `backup snapshots`; the default is the latest.
- `--only` restores part of it. After losing only the file storage, `--only objects` uploads what the bucket lacks.
- `--prune-bucket` also deletes objects the backup does not have. It is off by default: extra objects are harmless orphans.
- `--yes` skips the question (required when there is no terminal).
- A backup from a newer release than the one installed is refused: install that release first.

To restore into another stack, for example to rehearse, select it as for any command: `REI_ENV_DIR=~/.rei-test ./rei backup restore --repo /path/to/rei-backups`. Check a restore on a spare stack before you need it.

If a step fails after Rei was stopped, Rei stays stopped, and the message names the volumes that hold the rollback copies and the downloaded backup. Nothing is deleted until you remove those volumes yourself:

```sh
docker volume ls | grep pre-restore
docker volume rm rei_control-data-pre-restore-<time>
```

Once the restored Rei is running and you are satisfied, remove the `-pre-restore-` volumes to reclaim the space.
