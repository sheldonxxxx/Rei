# Sourced by the smoke scripts (bash): which stack they check, chosen the way ./rei chooses it.
#   REI_ENV_DIR   the directory holding .env and .secrets/secrets.env (default: this directory). A relative path is taken
#                 from the directory the script was started in; ~ is the home directory.
#   REI_PROJECT   Rei's compose project (default rei); Dodai's is <REI_PROJECT>-dodai, or dodai for the default.
#   REI_NET       the first two octets of the stack's fixed subnets (default 10.89).
# REI_PROJECT and REI_NET come from the environment, else from $REI_ENV_DIR/.env. Sets: env_dir, project, net, compose
# (Rei's project) and shared (Dodai's), both with the env files, and exports the three variables so a nested ./rei call
# and compose's own interpolation see the same stack. The caller must source it before changing directory.
stack_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env_dir=${REI_ENV_DIR:-$stack_here}
case $env_dir in
  "~") env_dir=$HOME ;;
  "~/"*) env_dir=$HOME/${env_dir#"~/"} ;;
esac
env_dir=$(cd "$env_dir" 2>/dev/null && pwd) || {
  echo "FAIL  REI_ENV_DIR (${REI_ENV_DIR:-}) is not a directory"
  exit 1
}
# The last KEY=value line of .env, unquoted, as compose reads it.
stack_env_value() {
  [[ -f $env_dir/.env ]] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$env_dir/.env" | tail -n 1 |
    sed -E -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'\$/\\1/" -e 's/[[:space:]]+#.*$//' -e 's/[[:space:]]+$//'
}
project=${REI_PROJECT:-$(stack_env_value REI_PROJECT)}
project=${project:-rei}
net=${REI_NET:-$(stack_env_value REI_NET)}
net=${net:-10.89}
export REI_ENV_DIR=$env_dir REI_PROJECT=$project REI_NET=$net
compose=(docker compose --env-file "$env_dir/.env" --env-file "$env_dir/.secrets/secrets.env" -f "$stack_here/compose.yaml")
shared=(docker compose --env-file "$env_dir/.env" --env-file "$env_dir/.secrets/secrets.env" -f "$stack_here/compose.dodai.yaml")
if [[ $project != rei ]]; then
  compose+=(-p "$project")
  shared+=(-p "$project-dodai")
fi
