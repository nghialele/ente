/**
 * @file Storage (in-memory, local, remote) and update of various settings.
 */

import { savedPartialLocalUser } from "ente-accounts/services/accounts-db";
import { isDevBuild } from "ente-base/env";
import log from "ente-base/log";
import { updateShouldDisableCFUploadProxy } from "ente-gallery/services/upload";
import { nullToUndefined } from "ente-utils/transform";
import { z } from "zod/v4";
import { fetchFeatureFlags, updateRemoteFlag } from "./remote-store";

/**
 * In-memory flags that tracks various settings.
 *
 * Some of these are local only, some of these are synced with remote.
 *
 * [Note: Remote flag lifecycle]
 *
 * At a high level, this is how the app manages remote flags:
 *
 * 1. On app start, the initial are read from local storage in
 *    {@link initSettings}.
 *
 * 2. During the remote pull, remote flags are fetched and saved in local
 *    storage, and the in-memory state updated to reflect the latest values
 *    ({@link pullSettings}).
 *
 * 3. Updating a value also cause an unconditional fetch and update
 *    ({@link pullSettings}).
 *
 * 4. The individual getter functions for the flags (e.g.
 *    {@link isInternalUser}) return the in-memory values, and so are suitable
 *    for frequent use during UI rendering.
 *
 * 5. Everything gets reset to the default state on {@link logoutSettings}.
 */
export interface Settings {
    /**
     * `true` if the current user is an internal user.
     */
    isInternalUser: boolean;

    /**
     * `true` if maps are enabled.
     */
    mapEnabled: boolean;

    /**
     * `true` if the user has saved a preference to disable workers for uploads.
     *
     * Unlike {@link shouldDisableCFUploadProxy}, whose value reflects other
     * factors that are taken into account to determine the effective value of
     * this setting, this function returns only the saved user preference.
     */
    cfUploadProxyDisabled: boolean;

    /**
     * The URL we should ask the user to open should they wish to pair with the
     * the cast app by manually entering a pairing code.
     *
     * Changing this only ever makes sense for self-hosters, who might want to
     * point to their own self hosted cast app (See `apps.cast` in `local.yaml`
     * in the museum code).
     *
     * Default: "https://cast.ente.io"
     */
    castURL: string;
}

const createDefaultSettings = (): Settings => ({
    isInternalUser: false,
    mapEnabled: false,
    cfUploadProxyDisabled: false,
    castURL: "https://cast.ente.io",
});

/**
 * Internal in-memory state shared by the functions in this module.
 *
 * This entire object will be reset on logout.
 */
class SettingsState {
    constructor() {
        this.settingsSnapshot = createDefaultSettings();
    }

    /**
     * Subscriptions to {@link Settings} updates attached using
     * {@link settingsSubscribe}.
     */
    settingsListeners: (() => void)[] = [];

    /**
     * Snapshot of the {@link Settings} returned by the {@link settingsSnapshot}
     * function.
     */
    settingsSnapshot: Settings;
}

/** State shared by the functions in this module. See {@link SettingsState}. */
let _state = new SettingsState();

/**
 * Read in the locally persisted settings into memory, but otherwise do not
 * initiate any network requests to fetch the latest values.
 *
 * This assumes that the user is already logged in.
 */
export const initSettings = () => {
    void updateShouldDisableCFUploadProxy(savedCFProxyDisabled());
    syncSettingsSnapshotWithLocalStorage();
};

export const logoutSettings = () => {
    _state = new SettingsState();
};

/**
 * Fetch remote flags from remote and save them in local storage for subsequent
 * lookup. Then use the results to update our in memory state if needed.
 */
export const pullSettings = async () => {
    const jsonString = await fetchFeatureFlags().then((res) => res.text());
    // Do a parse as a sanity check before saving the string contents.
    FeatureFlags.parse(JSON.parse(jsonString));
    saveRemoteFeatureFlagsJSONString(jsonString);
    syncSettingsSnapshotWithLocalStorage();
};

const saveRemoteFeatureFlagsJSONString = (s: string) =>
    localStorage.setItem("remoteFeatureFlags", s);

const savedRemoteFeatureFlags = () => {
    const s = localStorage.getItem("remoteFeatureFlags");
    if (!s) return undefined;
    try {
        return FeatureFlags.parse(JSON.parse(s));
    } catch (e) {
        log.warn("Ignoring unparseable saved remoteFeatureFlags", e);
        return undefined;
    }
};

const FeatureFlags = z.object({
    internalUser: z.boolean().nullish().transform(nullToUndefined),
    betaUser: z.boolean().nullish().transform(nullToUndefined),
    mapEnabled: z.boolean().nullish().transform(nullToUndefined),
    castUrl: z.string().nullish().transform(nullToUndefined),
});

type FeatureFlags = z.infer<typeof FeatureFlags>;

const syncSettingsSnapshotWithLocalStorage = () => {
    const flags = savedRemoteFeatureFlags();
    const settings = createDefaultSettings();
    settings.isInternalUser = flags?.internalUser || false;
    settings.mapEnabled = flags?.mapEnabled || false;
    settings.cfUploadProxyDisabled = savedCFProxyDisabled();
    if (flags?.castUrl) settings.castURL = flags.castUrl;
    setSettingsSnapshot(settings);
};

/**
 * A function that can be used to subscribe to updates to {@link Settings}.
 *
 * See: [Note: Snapshots and useSyncExternalStore].
 */
export const settingsSubscribe = (onChange: () => void): (() => void) => {
    _state.settingsListeners.push(onChange);
    return () => {
        _state.settingsListeners = _state.settingsListeners.filter(
            (l) => l != onChange,
        );
    };
};

/**
 * Return the last known, cached {@link Settings}.
 *
 * See also {@link settingsSubscribe}.
 */
export const settingsSnapshot = () => _state.settingsSnapshot;

const setSettingsSnapshot = (snapshot: Settings) => {
    _state.settingsSnapshot = snapshot;
    _state.settingsListeners.forEach((l) => l());
};

/**
 * Return `true` if this is a development build, and the current user (if any)
 * is marked as an "development" user.
 *
 * Emails that end in "@ente.io" are considered as dev users.
 */
export const isDevBuildAndUser = () => isDevBuild && isDevUserViaEmail();

const isDevUserViaEmail = () =>
    !!savedPartialLocalUser()?.email?.endsWith("@ente.io");

/**
 * Persist the user's map enabled preference both locally and on remote.
 */
export const updateMapEnabled = async (isEnabled: boolean) => {
    await updateRemoteFlag("mapEnabled", isEnabled);
    return pullSettings();
};

const cfProxyDisabledKey = "cfProxyDisabled";

const saveCFProxyDisabled = (v: boolean) =>
    v
        ? localStorage.setItem(cfProxyDisabledKey, "1")
        : localStorage.removeItem(cfProxyDisabledKey);

const savedCFProxyDisabled = () => {
    const v = localStorage.getItem(cfProxyDisabledKey);
    if (!v) return false;
    if (v == "1") return true;

    // Older versions of the app used to store this flag in a different
    // format, so see if this is one of those, and if so, migrate it too.
    try {
        const value = z
            .object({ value: z.boolean() })
            .parse(JSON.parse(v)).value;
        saveCFProxyDisabled(value);
        return value;
    } catch (e) {
        log.warn(`Ignoring ${cfProxyDisabledKey} value: ${v}`, e);
        localStorage.removeItem(cfProxyDisabledKey);
        return false;
    }
};

/**
 * Save the user preference for disabling uploads via Cloudflare Workers, also
 * notifying the upload subsystem of the change.
 */
export const updateCFProxyDisabledPreference = async (value: boolean) => {
    saveCFProxyDisabled(value);
    await updateShouldDisableCFUploadProxy(value);
    syncSettingsSnapshotWithLocalStorage();
};
