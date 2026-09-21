// runtime/lib/config-path.mts — resolves the runtime's own config directory.
//
// Gate-specific (not shared): the runtime config dir is derived from this
// module's location, so it MUST live inside runtime/lib — from here it lands
// on runtime/config whether the runtime is baked at /opt/defined/runtime in
// the image or checked out on a host. Shared lib/ must never resolve the
// runtime's config.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a config file by name under the runtime's config directory,
 * derived from this module's location — never the CWD. Works identically
 * when runtime/ is bind-mounted at /opt/defined/runtime in the container or
 * run from a host checkout, and keeps configs travelling with the gate code.
 * (`standardsDir` below resolves the managed-file sources the same way.)
 */
export async function gateConfigPath({
    name,
}: {
    name: string;
}): Promise<string> {
    const gateRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    return join(gateRoot, "config", name);
}

/**
 * Resolve the standards directory (sibling of runtime/) — the single source
 * of truth for shared managed files installed by setup. Derived from this
 * module's location like gateConfigPath: works baked at /opt/defined/standards
 * in the container or from a host checkout.
 */
export async function standardsDir(): Promise<string> {
    const gateRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    return join(dirname(gateRoot), "standards");
}
