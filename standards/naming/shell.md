# Shell naming conventions

Part of the house naming doctrine (see [`../naming.md`](../naming.md)). This
file is the authority for shell function and file names.

One question, one answer:

> **What you type is kebab (`-`), what you call is snake (`_`).**

If a rule here is unclear or a name does not fit, change this document — do not
silently invent a fourth style.

## The three tiers

Every shell function is exactly one of three tiers. The tier decides the prefix
**and** the separator, so there is never a choice to make:

| Tier        | Prefix       | Separator | Example                                          | Used for                                  |
| ----------- | ------------ | --------- | ------------------------------------------------ | ----------------------------------------- |
| **Command** | none         | `-`       | `usb-format`, `git-branch`, `get-ip`             | Things you type at the prompt             |
| **Library** | `bootstrap_` | `_`       | `bootstrap_log_info`, `bootstrap_install_podman` | Callable from scripts, never typed        |
| **Private** | `_`          | `_`       | `_usb_prepare_target`                            | File-local helpers, no cross-file callers |

- **Commands** are the interactive surface. `git-branch`, `ssh-setup`,
  `usb-format` read like git/ssh subcommands and need no shift key. Short
  single-word aliases are allowed (`code`, `tdd`, `upd`, `space`, `cleantree`).
- **Libraries** group under one Tab prefix (`boot<Tab>` lists them all), so a
  bare first letter never drowns in helper names. `bootstrap_` says "part of the
  shared toolset, call me from a script — I'm not a command".
- **Private** functions are `_`-prefixed to signal "implementation detail, may
  change without notice". This is why libraries are `bootstrap_*` and _not_
  `_*`: `_` would falsely imply private.

## Word order

- **Command:** subsystem namespace first, then verb: `git-branch`,
  `usb-format`, `wifi-scan`. Standalone commands are verb-first: `get-ip`,
  `repeat-test`, `add-ssh-key-to-github`.
- **Library:** `bootstrap_` → verb → subject → detail:
  `bootstrap_install_brave_browser`, `bootstrap_ensure_directory`,
  `bootstrap_prompt_yes_no`.
- **Private:** `_` → topic → verb → subject: `_usb_prepare_target`,
  `_dotnet_ms_repo_deb_url`.

### Verb vocabulary

The first word after any prefix is a verb from this list. If you need a verb
not here, add it to the list and this document — do not improvise a synonym.

| Group       | Verbs                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Predicates  | `is_` (`bootstrap_is_arch_like`), `has_`                                                      |
| Guards      | `require_` (`bootstrap_require_command`), `validate_` (`bootstrap_validate_non_empty`)        |
| Lifecycle   | `install_`, `update_`, `remove_`, `uninstall_`                                                |
| Query       | `get_` (`bootstrap_get_distro`), `list_`, `scan_`, `check_`, `status_`                        |
| Mutate      | `set_`, `create_`, `ensure_`, `add_`, `backup_`, `link_`, `download_`, `extract_`             |
| Interaction | `prompt_` (`bootstrap_prompt_yes_no`), `connect_`, `format_`, `flash_`, `generate_`, `write_` |
| Orchestrate | `run_` (`run_dev`), `setup_` (`bootstrap_setup_steam_symlinks`)                               |

Internal helper functions whose whole job is a sub-step of one verb keep the
topic noun first after the `_` (`_usb_require_removable_device`), because the
topic disambiguates across files.

## Files

- **All file names are kebab-case, lowercase.** No underscores in filenames.
- `functions/`: `<topic>-functions.sh` for libraries, `<command>.sh` for
  single commands.
- `installers/`: `<app>.sh`. An installer file must define
  `bootstrap_install_<app-with-dashes-as-underscores>()` — e.g.
  `installers/brave-browser.sh` → `bootstrap_install_brave_browser`. Upstream
  proper nouns and setup verbs are allowlisted exceptions (for example
  `installers/setup-steam-symlinks.sh` → `bootstrap_setup_steam_symlinks`).
- `bin/`: thin executable scripts, first line `#!/usr/bin/env node` for Node
  entry points.

## Exceptions

Project-local tooling keeps its own vocabulary when it is never sourced into a
shell and forms a separate toolset — for example `quality/` `check_*`/`run_*`/
`assert_*` helpers and `bootstrap.sh` `run_*` group orchestrators. Record such
exceptions in the enforcing rules command, not by silently renaming.

## Enforcement

Shell naming is not enforced by a built-in gate step. A project declares its own
rules command under the `.defined.json` `naming` key (see
[`../naming.md`](../naming.md)); `quality/naming.sh` is the reference
implementation — it rejects bare snake_case and camelCase function names and
checks every installer file defines the function its name implies.
