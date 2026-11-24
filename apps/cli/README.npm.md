# rei-ai

The command-line installer for [Rei レイ](https://github.com/sheldonxxxx/Rei), a personal AI workspace that runs on your own computer in Docker. It sets Rei up from the published container images, starts and stops it, checks it, and upgrades it. Nothing is built on your machine.

## Requirements

- Docker with Docker Compose v2.20 or newer, running on this machine
- Node.js 26 or newer
- macOS or Linux; on Windows, use WSL2

## Install

```sh
npx rei-ai setup
```

or install the `rei` command once:

```sh
npm i -g rei-ai
rei setup
```

Setup writes its files to `~/.rei` (set `REI_HOME` to use another folder), creates the secrets and storage volumes, pulls the images and starts the services. At the end, open the printed address and create your account. Models, memory and web search are configured in the web app.

## Everyday commands

```sh
rei status      # is Rei running?
rei stop        # stop Rei (rei stop --all: Dodai too)
rei start
rei doctor      # find problems and how to fix them
rei setup-code  # the code for creating the first account
rei --help
```

## Upgrade

```sh
npm i -g rei-ai@latest
rei upgrade
```

`rei upgrade` copies the configuration to `~/.rei/backups/`, pulls the new images and recreates the services; your data stays in its Docker volumes and the new release upgrades its databases when it starts. Back up the data volumes first if you want a way back. Upgrade through each minor release in turn. A downgrade is refused.

Once a day `rei` may tell you a newer version exists. It never updates itself. Set `REI_NO_UPDATE_CHECK=1` to turn the check off.

See the [installation guide](https://github.com/sheldonxxxx/Rei/blob/main/docs/installation.md) for details and troubleshooting.
