"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type {
  Repository,
  CreateRepositoryRequest,
  DebianRepositoryConfig,
  DebianMetadataStrategy,
  DebianPackageFetchStrategy,
  RepositoryFormat,
  RepositoryType,
  VirtualRepoMemberInput,
} from "@/types";
import { FORMAT_OPTIONS, TYPE_OPTIONS } from "../_lib/constants";
import { DEFAULT_UPSTREAM_URLS } from "../_lib/default-upstream-urls";

// Alphabetised copy of FORMAT_OPTIONS for the create dialog's flat dropdown.
// The source array is deliberately ordered by ecosystem group so that the
// grouped filter in repositories-content.tsx renders its headers correctly;
// here we just want a predictable A-Z list for the user.
const SORTED_FORMAT_OPTIONS = [...FORMAT_OPTIONS].sort((a, b) =>
  a.label.localeCompare(b.label),
);

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/common/confirm-dialog";

type QuotaUnit = "MB" | "GB";

const BYTES_PER_MB = 1048576;
const BYTES_PER_GB = 1073741824;

/** Convert a quota value and unit to bytes. Returns null for empty/zero values. */
export function quotaToBytes(value: string, unit: QuotaUnit): number | null {
  const num = Number(value);
  if (!num || num <= 0 || !Number.isFinite(num)) return null;
  return Math.round(num * (unit === "GB" ? BYTES_PER_GB : BYTES_PER_MB));
}

/** Convert bytes to a human-friendly value and unit. Prefers GB when evenly divisible. */
export function bytesToQuota(bytes: number | undefined | null): { value: string; unit: QuotaUnit } {
  if (!bytes || bytes <= 0) return { value: "", unit: "GB" };
  if (bytes >= BYTES_PER_GB && bytes % BYTES_PER_GB === 0) {
    return { value: String(bytes / BYTES_PER_GB), unit: "GB" };
  }
  return { value: String(Math.round(bytes / BYTES_PER_MB)), unit: "MB" };
}

interface DebianFormValues {
  distributionPaths: string;
  components: string;
  architectures: string;
  includeSourcePackages: boolean;
  flatRepository: boolean;
  metadataStrategy: DebianMetadataStrategy;
  packageFetchStrategy: DebianPackageFetchStrategy;
  verifyUpstreamMetadata: boolean;
  upstreamGpgKeyId: string;
  signingKeyId: string;
  ignoreMissingIndexes: boolean;
  packageQueries: string;
  resolveDependencies: boolean;
}

const EMPTY_DEBIAN_FORM: DebianFormValues = {
  distributionPaths: "",
  components: "",
  architectures: "",
  includeSourcePackages: false,
  flatRepository: false,
  metadataStrategy: "upstream_passthrough",
  packageFetchStrategy: "cache_on_request",
  verifyUpstreamMetadata: false,
  upstreamGpgKeyId: "",
  signingKeyId: "",
  ignoreMissingIndexes: false,
  packageQueries: "",
  resolveDependencies: false,
};

const DEBIAN_FILTER_HELPER =
  "Leave blank or use * to include all values advertised by upstream metadata.";

function splitDebianList(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function debianListResolvesToAll(value: string): boolean {
  const values = splitDebianList(value);
  return values.length === 0 || values.includes("*");
}

function debianConfigToForm(config?: DebianRepositoryConfig): DebianFormValues {
  const legacy = config as (DebianRepositoryConfig & { distributions?: string[] }) | undefined;
  return {
    distributionPaths: (config?.distribution_paths ?? legacy?.distributions ?? []).join(", "),
    components: config?.components?.join(", ") ?? "",
    architectures: config?.architectures?.join(", ") ?? "",
    includeSourcePackages: config?.include_source_packages ?? false,
    flatRepository: config?.flat_repository ?? false,
    metadataStrategy: config?.metadata_strategy ?? "upstream_passthrough",
    packageFetchStrategy: config?.package_fetch_strategy ?? "cache_on_request",
    verifyUpstreamMetadata: config?.verify_upstream_metadata ?? false,
    upstreamGpgKeyId: config?.upstream_gpg_key_id ?? "",
    signingKeyId: config?.signing_key_id ?? "",
    ignoreMissingIndexes: config?.ignore_missing_indexes ?? false,
    packageQueries: (config?.package_queries ?? []).join(", "),
    resolveDependencies: config?.resolve_dependencies ?? false,
  };
}

function buildDebianConfig(values: DebianFormValues): DebianRepositoryConfig {
  return {
    distribution_paths: splitDebianList(values.distributionPaths),
    components: splitDebianList(values.components),
    architectures: splitDebianList(values.architectures),
    include_source_packages: values.includeSourcePackages,
    flat_repository: values.flatRepository,
    metadata_strategy: values.metadataStrategy,
    package_fetch_strategy: values.packageFetchStrategy,
    verify_upstream_metadata: values.verifyUpstreamMetadata,
    upstream_gpg_key_id: values.upstreamGpgKeyId.trim() || undefined,
    signing_key_id: values.signingKeyId.trim() || undefined,
    ignore_missing_indexes: values.ignoreMissingIndexes,
    package_queries: splitDebianList(values.packageQueries),
    resolve_dependencies: values.resolveDependencies,
  };
}

function debianWarnings(values: DebianFormValues): string[] {
  const componentsAll = debianListResolvesToAll(values.components);
  const architecturesAll = debianListResolvesToAll(values.architectures);
  const warnings: string[] = [];

  if (componentsAll) {
    warnings.push(
      "Components are set to all. Artifact Keeper will read all components advertised by the upstream Release metadata for the selected distribution(s). This may increase metadata size, package visibility, and storage usage if package prefetching is enabled.",
    );
  }
  if (architecturesAll) {
    warnings.push(
      "Architectures are set to all. Artifact Keeper will read all architectures advertised by the upstream Release metadata for the selected distribution(s). This may significantly increase metadata size and package visibility. Use a specific architecture such as amd64 or arm64 to reduce scope.",
    );
  }
  if (values.packageFetchStrategy === "prefetch_selected" && (componentsAll || architecturesAll)) {
    warnings.push(
      "Prefetch is enabled with broad component or architecture selection. Artifact Keeper may download a large number of packages and consume significant storage. Consider using cache_on_request or narrowing the filters.",
    );
  }
  if (
    values.metadataStrategy === "upstream_passthrough" &&
    (!componentsAll || !architecturesAll)
  ) {
    warnings.push(
      "Component and architecture filters are ignored while metadata strategy is upstream passthrough. Artifact Keeper serves upstream Release metadata unchanged. Switch to filter and generate (or filter, generate, and sign) for filters to take effect.",
    );
  }
  if (values.metadataStrategy === "filter_generate_and_sign" && !values.verifyUpstreamMetadata) {
    warnings.push(
      "Filter, generate, and sign requires verify upstream metadata so Artifact Keeper only re-signs metadata from a verified upstream.",
    );
  }
  if (values.metadataStrategy === "filter_generate_and_sign" && !values.signingKeyId.trim()) {
    warnings.push(
      "Filter, generate, and sign requires a signing key ID (a key with private material from Signing Keys).",
    );
  }
  if (values.verifyUpstreamMetadata && !values.upstreamGpgKeyId.trim()) {
    warnings.push(
      "Verify upstream metadata requires an upstream GPG key ID. Import the Debian/Ubuntu archive public key on the Signing Keys page, then enter its name, fingerprint, or key ID here.",
    );
  }

  return warnings;
}
interface DebianConfigFieldsProps {
  idPrefix: "create" | "edit";
  values: DebianFormValues;
  onChange: (values: DebianFormValues) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  isRemote: boolean;
}

function DebianConfigFields({
  idPrefix,
  values,
  onChange,
  enabled,
  onEnabledChange,
  isRemote,
}: DebianConfigFieldsProps) {
  const update = <K extends keyof DebianFormValues>(
    key: K,
    value: DebianFormValues[K],
  ) => onChange({ ...values, [key]: value });
  const warnings = enabled ? debianWarnings(values) : [];

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">APT filtering and metadata settings</h3>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${idPrefix}-debian-enabled`}
            checked={enabled}
            onCheckedChange={onEnabledChange}
          />
          <Label htmlFor={`${idPrefix}-debian-enabled`} className="whitespace-nowrap">
            Enable
          </Label>
        </div>
      </div>

      {enabled && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-debian-distribution-paths`}>Distribution paths</Label>
            <Input
              id={`${idPrefix}-debian-distribution-paths`}
              placeholder="jammy, jammy-updates"
              value={values.distributionPaths}
              onChange={(event) => update("distributionPaths", event.target.value)}
              required
            />
          </div>

          {warnings.length > 0 && (
            <div className="space-y-2" role="alert">
              {warnings.map((warning) => (
                <div
                  key={warning}
                  className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-900 dark:border-yellow-900/60 dark:bg-yellow-950/40 dark:text-yellow-200"
                >
                  {warning}
                </div>
              ))}
            </div>
          )}

          <details className="space-y-4 rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced Debian/APT settings
            </summary>
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`${idPrefix}-debian-components`}>Components</Label>
                  <Input
                    id={`${idPrefix}-debian-components`}
                    placeholder="main, universe"
                    value={values.components}
                    onChange={(event) => update("components", event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{DEBIAN_FILTER_HELPER}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${idPrefix}-debian-architectures`}>Architectures</Label>
                  <Input
                    id={`${idPrefix}-debian-architectures`}
                    placeholder="amd64, arm64"
                    value={values.architectures}
                    onChange={(event) => update("architectures", event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{DEBIAN_FILTER_HELPER}</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`${idPrefix}-debian-metadata-strategy`}>Metadata strategy</Label>
                  <Select
                    value={values.metadataStrategy}
                    onValueChange={(value) => {
                      const strategy = value as DebianMetadataStrategy;
                      if (strategy === "filter_generate_and_sign") {
                        onChange({
                          ...values,
                          metadataStrategy: strategy,
                          verifyUpstreamMetadata: true,
                        });
                      } else {
                        update("metadataStrategy", strategy);
                      }
                    }}
                  >
                    <SelectTrigger id={`${idPrefix}-debian-metadata-strategy`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="upstream_passthrough">Upstream passthrough</SelectItem>
                      <SelectItem value="filter_and_generate">Filter and generate</SelectItem>
                      <SelectItem value="filter_generate_and_sign">Filter, generate, and sign</SelectItem>
                      <SelectItem value="hosted_generate">Hosted generate</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {isRemote && (
                  <div className="space-y-2">
                    <Label htmlFor={`${idPrefix}-debian-package-fetch-strategy`}>
                      Package fetch strategy
                    </Label>
                    <Select
                      value={values.packageFetchStrategy}
                      onValueChange={(value) =>
                        update("packageFetchStrategy", value as DebianPackageFetchStrategy)
                      }
                    >
                      <SelectTrigger id={`${idPrefix}-debian-package-fetch-strategy`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cache_on_request">Cache on request</SelectItem>
                        <SelectItem value="prefetch_selected">Prefetch selected</SelectItem>
                        <SelectItem value="passthrough">Passthrough</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-3">
                  <Switch
                    id={`${idPrefix}-debian-source-packages`}
                    checked={values.includeSourcePackages}
                    onCheckedChange={(checked) => update("includeSourcePackages", checked)}
                  />
                  <Label htmlFor={`${idPrefix}-debian-source-packages`}>
                    Include source packages
                  </Label>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id={`${idPrefix}-debian-flat-repository`}
                    checked={values.flatRepository}
                    onCheckedChange={(checked) => update("flatRepository", checked)}
                  />
                  <Label htmlFor={`${idPrefix}-debian-flat-repository`}>Flat repository</Label>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id={`${idPrefix}-debian-verify-upstream`}
                    checked={values.verifyUpstreamMetadata}
                    onCheckedChange={(checked) => update("verifyUpstreamMetadata", checked)}
                  />
                  <Label htmlFor={`${idPrefix}-debian-verify-upstream`}>
                    Verify upstream metadata
                  </Label>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id={`${idPrefix}-debian-ignore-missing`}
                    checked={values.ignoreMissingIndexes}
                    onCheckedChange={(checked) => update("ignoreMissingIndexes", checked)}
                  />
                  <Label htmlFor={`${idPrefix}-debian-ignore-missing`}>Ignore missing indexes</Label>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-debian-package-queries`}>Package queries</Label>
                <Textarea
                  id={`${idPrefix}-debian-package-queries`}
                  placeholder="nginx, curl*, openssh-*"
                  value={values.packageQueries}
                  onChange={(event) => update("packageQueries", event.target.value)}
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">
                  Comma or newline separated. Exact names or trailing <code>*</code> globs.
                  Leave blank to include all packages matching component/architecture filters.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id={`${idPrefix}-debian-resolve-deps`}
                  checked={values.resolveDependencies}
                  onCheckedChange={(checked) => update("resolveDependencies", checked)}
                  disabled={!values.packageQueries.trim()}
                />
                <Label htmlFor={`${idPrefix}-debian-resolve-deps`}>
                  Resolve dependencies for package queries
                </Label>
              </div>

              {values.verifyUpstreamMetadata && (
                <div className="space-y-2">
                  <Label htmlFor={`${idPrefix}-debian-upstream-gpg-key`}>Upstream GPG key</Label>
                  <Input
                    id={`${idPrefix}-debian-upstream-gpg-key`}
                    placeholder="ubuntu-archive-key or fingerprint"
                    value={values.upstreamGpgKeyId}
                    onChange={(event) => update("upstreamGpgKeyId", event.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Name, fingerprint, or key ID of a stored public trust anchor.
                    Import the archive public key from Signing Keys → Import public key.
                  </p>
                </div>
              )}

              {values.metadataStrategy === "filter_generate_and_sign" && (
                <div className="space-y-2">
                  <Label htmlFor={`${idPrefix}-debian-signing-key`}>Signing key</Label>
                  <Input
                    id={`${idPrefix}-debian-signing-key`}
                    placeholder="signing key UUID"
                    value={values.signingKeyId}
                    onChange={(event) => update("signingKeyId", event.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Must be a key with private material (can_sign). Public-only trust
                    anchors can verify upstream but cannot re-sign metadata.
                  </p>
                </div>
              )}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
interface RepoDialogsProps {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onCreateSubmit: (data: CreateRepositoryRequest) => void;
  createPending: boolean;
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  editRepo: Repository | null;
  onEditSubmit: (key: string, data: Partial<CreateRepositoryRequest>) => void;
  editPending: boolean;
  onUpstreamAuthUpdate?: (key: string, payload: { auth_type: string; username?: string; password?: string }) => void;
  upstreamAuthPending?: boolean;
  /**
   * Result of the most recent upstream-auth save, surfaced to a live region
   * inside the edit dialog so screen readers hear the outcome (#410). The
   * save itself resolves via a parent mutation whose only feedback was a
   * visual toast, which assistive tech outside the dialog does not reliably
   * announce.
   */
  upstreamAuthStatus?: { state: "idle" | "success" | "error"; message?: string };
  deleteOpen: boolean;
  onDeleteOpenChange: (open: boolean) => void;
  deleteRepo: Repository | null;
  onDeleteConfirm: (key: string) => void;
  deletePending: boolean;
  // Available repos for virtual repo member selection
  availableRepos?: Repository[];
}

export function RepoDialogs({
  createOpen,
  onCreateOpenChange,
  onCreateSubmit,
  createPending,
  editOpen,
  onEditOpenChange,
  editRepo,
  onEditSubmit,
  editPending,
  onUpstreamAuthUpdate,
  upstreamAuthPending = false,
  upstreamAuthStatus = { state: "idle" },
  deleteOpen,
  onDeleteOpenChange,
  deleteRepo,
  onDeleteConfirm,
  deletePending,
  availableRepos = [],
}: RepoDialogsProps) {
  // Create form state
  const [createForm, setCreateForm] = useState<CreateRepositoryRequest>({
    key: "",
    name: "",
    description: "",
    format: "generic",
    repo_type: "local",
    is_public: true,
    upstream_url: "",
    member_repos: [],
  });

  // For virtual repos: selected member repo keys
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  // Quota state for create dialog
  const [createQuotaValue, setCreateQuotaValue] = useState("");
  const [createQuotaUnit, setCreateQuotaUnit] = useState<QuotaUnit>("GB");

  // Upstream auth state for create dialog
  const [upstreamAuthType, setUpstreamAuthType] = useState<string>("none");
  const [upstreamUsername, setUpstreamUsername] = useState("");
  const [upstreamPassword, setUpstreamPassword] = useState("");
  const [createDebianForm, setCreateDebianForm] =
    useState<DebianFormValues>(EMPTY_DEBIAN_FORM);
  const [createDebianEnabled, setCreateDebianEnabled] = useState(false);

  /**
   * Suggest a default upstream URL when the repo type is "remote".
   * Only auto-fills if the current URL is empty or matches a known default
   * (i.e. the user hasn't typed a custom value).
   */
  const maybeSetDefaultUpstreamUrl = useCallback(
    (format: string, repoType: string, currentUrl: string) => {
      if (repoType !== "remote") return;
      const defaultUrl = DEFAULT_UPSTREAM_URLS[format] ?? "";
      const isDefault = currentUrl === "" || Object.values(DEFAULT_UPSTREAM_URLS).includes(currentUrl);
      if (isDefault && defaultUrl) {
        setCreateForm((f) => ({ ...f, upstream_url: defaultUrl }));
      }
    },
    []
  );

  // Upstream auth state for edit dialog
  const [editAuthMode, setEditAuthMode] = useState<"view" | "edit">("view");
  const [editAuthType, setEditAuthType] = useState<string>("none");
  const [editAuthUsername, setEditAuthUsername] = useState("");
  const [editAuthPassword, setEditAuthPassword] = useState("");
  const [removeAuthConfirm, setRemoveAuthConfirm] = useState(false);
  const [editDebianOverrides, setEditDebianOverrides] =
    useState<Partial<DebianFormValues>>({});
  const [editDebianUpstreamOverride, setEditDebianUpstreamOverride] =
    useState<string>();
  const [editDebianEnabledOverride, setEditDebianEnabledOverride] = useState<boolean>();

  // Focus management for the upstream-auth view <-> edit toggle (#412).
  // When the user switches modes the previously focused control unmounts, so
  // focus would otherwise fall back to <body> and screen-reader / keyboard
  // users lose their place. We move focus to the first control of whichever
  // view just became visible. We target elements by id (rather than a ref)
  // because the underlying shadcn SelectTrigger does not forward a ref.
  // Skip the very first render (dialog open) so we don't steal focus from the
  // dialog's own initial focus target; only react to genuine toggles.
  const editAuthModeInitialized = useRef(false);
  useEffect(() => {
    if (!editOpen) {
      editAuthModeInitialized.current = false;
      return;
    }
    if (!editAuthModeInitialized.current) {
      editAuthModeInitialized.current = true;
      return;
    }
    const targetId =
      editAuthMode === "edit" ? "edit-upstream-auth-type" : "edit-upstream-auth-toggle";
    // Defer to the next frame so the newly-rendered control exists in the DOM.
    const id = requestAnimationFrame(() => {
      document.getElementById(targetId)?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [editAuthMode, editOpen]);

  // Quota state for edit dialog — initialized from editRepo
  const editQuotaDefaults = useMemo(() => bytesToQuota(editRepo?.quota_bytes), [editRepo]);
  const [editQuotaOverrides, setEditQuotaOverrides] = useState<{ value?: string; unit?: QuotaUnit }>({});
  const editQuotaValue = editQuotaOverrides.value ?? editQuotaDefaults.value;
  const editQuotaUnit = editQuotaOverrides.unit ?? editQuotaDefaults.unit;

  // Key validation - check if key is already taken
  const keyTaken = useMemo(() => {
    if (!createForm.key || createForm.key.length < 2) {
      return false;
    }
    return availableRepos.some(
      (r) => r.key.toLowerCase() === createForm.key.toLowerCase()
    );
  }, [createForm.key, availableRepos]);

  // Filter repos that can be members (local and remote, same format)
  const eligibleMembers = useMemo(() => {
    return availableRepos.filter(
      (r) => (r.repo_type === "local" || r.repo_type === "remote") &&
             r.format === createForm.format
    );
  }, [availableRepos, createForm.format]);

  // Edit form state — derived from editRepo, with local overrides
  const editFormDefaults = useMemo(() => ({
    key: editRepo?.key ?? "",
    name: editRepo?.name ?? "",
    description: editRepo?.description ?? "",
    is_public: editRepo?.is_public ?? true,
  }), [editRepo]);
  const [editFormOverrides, setEditFormOverrides] = useState<{
    key?: string;
    name?: string;
    description?: string;
    is_public?: boolean;
  }>({});
  const editForm = { ...editFormDefaults, ...editFormOverrides };
  const editDebianDefaults = useMemo(
    () => debianConfigToForm(editRepo?.debian),
    [editRepo],
  );
  const editDebianForm = { ...editDebianDefaults, ...editDebianOverrides };
  const editDebianEnabled = editDebianEnabledOverride ?? Boolean(editRepo?.debian);
  const editDebianUpstreamUrl =
    editDebianUpstreamOverride ?? editRepo?.upstream_url ?? "";
  const editKeyChanged = editRepo ? editForm.key !== editRepo.key : false;

  const resetCreateForm = () => {
    setCreateForm({
      key: "",
      name: "",
      description: "",
      format: "generic",
      repo_type: "local",
      is_public: true,
      upstream_url: "",
      member_repos: [],
    });
    setSelectedMembers([]);
    setCreateQuotaValue("");
    setCreateQuotaUnit("GB");
    setUpstreamAuthType("none");
    setUpstreamUsername("");
    setUpstreamPassword("");
    setCreateDebianForm(EMPTY_DEBIAN_FORM);
    setCreateDebianEnabled(false);
  };

  // Reset the create form whenever the dialog closes. The parent flips
  // `createOpen` back to false programmatically on a successful submit
  // (mutation onSuccess), but Radix Dialog does NOT fire onOpenChange for
  // programmatic close — so handleCreateClose's reset path is bypassed and
  // stale form values would otherwise persist into the next open.
  useEffect(() => {
    if (!createOpen) {
      // Closing is also driven programmatically after successful mutations;
      // reset all draft-only fields at that boundary.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      resetCreateForm();
    }
  }, [createOpen]);

  // Build member_repos array from selected keys
  const buildMemberRepos = (): VirtualRepoMemberInput[] => {
    return selectedMembers.map((key, idx) => ({
      repo_key: key,
      priority: idx + 1,
    }));
  };

  const handleCreateClose = (open: boolean) => {
    onCreateOpenChange(open);
    if (!open) {
      resetCreateForm();
    }
  };

  // --- Create Repository Dialog ---
  return (
    <>
      <Dialog open={createOpen} onOpenChange={handleCreateClose}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Repository</DialogTitle>
            <DialogDescription>
              Add a new artifact repository to your registry.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const submitData: CreateRepositoryRequest = {
                ...createForm,
                quota_bytes: quotaToBytes(createQuotaValue, createQuotaUnit) ?? undefined,
                upstream_url: createForm.repo_type === "remote" ? createForm.upstream_url : undefined,
                member_repos: createForm.repo_type === "virtual" ? buildMemberRepos() : undefined,
                ...(createForm.format === "debian" &&
                (createForm.repo_type === "local" || createForm.repo_type === "remote") &&
                createDebianEnabled
                  ? { debian: buildDebianConfig(createDebianForm) }
                  : {}),
              };
              if (createForm.repo_type === "remote" && upstreamAuthType !== "none") {
                submitData.upstream_auth_type = upstreamAuthType;
                if (upstreamAuthType === "basic") {
                  submitData.upstream_username = upstreamUsername;
                }
                submitData.upstream_password = upstreamPassword;
              }
              onCreateSubmit(submitData);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="create-key">Key</Label>
              <Input
                id="create-key"
                placeholder="my-repo"
                value={createForm.key}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, key: e.target.value }))
                }
                required
                aria-required="true"
                aria-invalid={keyTaken}
                aria-describedby={keyTaken ? "create-key-error" : undefined}
                className={keyTaken ? "border-red-500 focus-visible:ring-red-500" : ""}
              />
              {keyTaken && (
                <p id="create-key-error" role="alert" className="text-sm text-red-500">
                  Repository key &quot;{createForm.key}&quot; is already taken. Please choose a different key.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-name">Name</Label>
              <Input
                id="create-name"
                placeholder="My Repository"
                value={createForm.name}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, name: e.target.value }))
                }
                required
                aria-required="true"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-desc">Description</Label>
              <Textarea
                id="create-desc"
                placeholder="Optional description..."
                value={createForm.description}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, description: e.target.value }))
                }
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Format</Label>
                <Select
                  value={createForm.format}
                  onValueChange={(v) => {
                    setCreateForm((f) => ({
                      ...f,
                      format: v as RepositoryFormat,
                    }));
                    maybeSetDefaultUpstreamUrl(v, createForm.repo_type, createForm.upstream_url ?? "");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SORTED_FORMAT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={createForm.repo_type}
                  onValueChange={(v) => {
                    setCreateForm((f) => ({
                      ...f,
                      repo_type: v as RepositoryType,
                    }));
                    maybeSetDefaultUpstreamUrl(createForm.format, v, createForm.upstream_url ?? "");
                    if (v !== "remote") {
                      setUpstreamAuthType("none");
                      setUpstreamUsername("");
                      setUpstreamPassword("");
                    }
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Staging repository: inline hint */}
            {createForm.repo_type === "staging" && (
              <p className="text-xs text-muted-foreground">
                Staging repos hold artifacts for review before promotion to a release repository.
                Configure promotion rules after creation.
              </p>
            )}
            {/* Remote repository: upstream URL */}
            {createForm.repo_type === "remote" && (
              <div className="space-y-2">
                <Label htmlFor="create-upstream">Upstream URL</Label>
                <Input
                  id="create-upstream"
                  placeholder={DEFAULT_UPSTREAM_URLS[createForm.format] ?? "https://upstream-registry.example.com"}
                  value={createForm.upstream_url || ""}
                  onChange={(e) =>
                    setCreateForm((f) => ({ ...f, upstream_url: e.target.value }))
                  }
                  required
                />
                <p className="text-xs text-muted-foreground">
                  The upstream registry URL to proxy requests to.
                </p>
              </div>
            )}

            {createForm.format === "debian" &&
              (createForm.repo_type === "local" || createForm.repo_type === "remote") && (
                <DebianConfigFields
                  idPrefix="create"
                  values={createDebianForm}
                  onChange={setCreateDebianForm}
                  enabled={createDebianEnabled}
                  onEnabledChange={setCreateDebianEnabled}
                  isRemote={createForm.repo_type === "remote"}
                />
              )}

            {/* Remote repository: upstream authentication */}
            {createForm.repo_type === "remote" && (
              <div className="space-y-3">
                <Label htmlFor="create-upstream-auth-type">Upstream Authentication</Label>
                <Select value={upstreamAuthType} onValueChange={setUpstreamAuthType}>
                  <SelectTrigger className="w-full" id="create-upstream-auth-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="basic">Basic (username + password)</SelectItem>
                    <SelectItem value="bearer">Bearer token</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Credentials are stored encrypted and used when fetching artifacts from the upstream registry.
                </p>

                {upstreamAuthType === "basic" && (
                  <>
                    <Label htmlFor="create-upstream-username">Username</Label>
                    <Input
                      id="create-upstream-username"
                      placeholder="Username"
                      required
                      value={upstreamUsername}
                      onChange={(e) => setUpstreamUsername(e.target.value)}
                      autoComplete="off"
                    />
                    <Label htmlFor="create-upstream-password">Password</Label>
                    <Input
                      id="create-upstream-password"
                      type="password"
                      placeholder="Password or access token"
                      required
                      value={upstreamPassword}
                      onChange={(e) => setUpstreamPassword(e.target.value)}
                      autoComplete="off"
                    />
                  </>
                )}

                {upstreamAuthType === "bearer" && (
                  <>
                    <Label htmlFor="create-upstream-token">Token</Label>
                    <Input
                      id="create-upstream-token"
                      type="password"
                      placeholder="Bearer token"
                      required
                      value={upstreamPassword}
                      onChange={(e) => setUpstreamPassword(e.target.value)}
                      autoComplete="off"
                    />
                  </>
                )}
              </div>
            )}

            {/* Virtual repository: member selection */}
            {createForm.repo_type === "virtual" && (
              <div className="space-y-2">
                <Label>Member Repositories</Label>
                {eligibleMembers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No {createForm.format} local or remote repositories available. Create some first.
                  </p>
                ) : (
                  <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1">
                    {eligibleMembers.map((repo) => (
                      <label
                        key={repo.key}
                        className="flex items-center gap-2 p-1 hover:bg-muted rounded cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedMembers.includes(repo.key)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedMembers((m) => [...m, repo.key]);
                            } else {
                              setSelectedMembers((m) => m.filter((k) => k !== repo.key));
                            }
                          }}
                          className="rounded"
                        />
                        <span className="text-sm">{repo.name}</span>
                        <span className="text-xs text-muted-foreground">({repo.repo_type})</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Select repositories to aggregate. Order determines priority.
                </p>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Switch
                id="create-public"
                checked={createForm.is_public}
                onCheckedChange={(v) =>
                  setCreateForm((f) => ({ ...f, is_public: v }))
                }
              />
              <Label htmlFor="create-public">Public repository</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-quota">Storage Quota</Label>
              <div className="flex gap-2">
                <Input
                  id="create-quota"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="No limit"
                  value={createQuotaValue}
                  onChange={(e) => setCreateQuotaValue(e.target.value)}
                  className="flex-1"
                />
                <Select
                  value={createQuotaUnit}
                  onValueChange={(v) => setCreateQuotaUnit(v as QuotaUnit)}
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MB">MB</SelectItem>
                    <SelectItem value="GB">GB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                Maximum storage for this repository. Leave empty for no limit.
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => handleCreateClose(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createPending || keyTaken}>
                {createPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* -- Edit Repository Dialog -- */}
      <Dialog open={editOpen} onOpenChange={(open) => {
        if (!open) {
          setEditFormOverrides({});
          setEditQuotaOverrides({});
          setEditAuthMode("view");
          setEditAuthType("none");
          setEditAuthUsername("");
          setEditAuthPassword("");
          setRemoveAuthConfirm(false);
          setEditDebianOverrides({});
          setEditDebianUpstreamOverride(undefined);
          setEditDebianEnabledOverride(undefined);
        }
        onEditOpenChange(open);
      }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Repository: {editRepo?.key}</DialogTitle>
            <DialogDescription>
              Update the repository name, description, or visibility.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (editRepo) {
                const { key: formKey, ...rest } = editForm;
                onEditSubmit(editRepo.key, {
                  ...rest,
                  ...(editKeyChanged ? { key: formKey } : {}),
                  quota_bytes: quotaToBytes(editQuotaValue, editQuotaUnit) ?? undefined,
                  ...(editRepo.format === "debian" && editRepo.repo_type === "remote"
                    ? { upstream_url: editDebianUpstreamUrl.trim() }
                    : {}),
                  ...(editRepo.format === "debian" &&
                  (editRepo.repo_type === "local" || editRepo.repo_type === "remote") &&
                  editDebianEnabled
                    ? { debian: buildDebianConfig(editDebianForm) }
                    : {}),
                });
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="edit-key">Key (URL slug)</Label>
              <Input
                id="edit-key"
                value={editForm.key}
                onChange={(e) =>
                  setEditFormOverrides((f) => ({ ...f, key: e.target.value.toLowerCase() }))
                }
                required
                aria-required="true"
                aria-describedby={editKeyChanged ? "edit-key-warning" : undefined}
              />
              {editKeyChanged && (
                <p
                  id="edit-key-warning"
                  role="status"
                  className="text-sm text-yellow-600 dark:text-yellow-500"
                >
                  Changing the key will update all URLs for this repository.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editForm.name}
                onChange={(e) =>
                  setEditFormOverrides((f) => ({ ...f, name: e.target.value }))
                }
                required
                aria-required="true"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-desc">Description</Label>
              <Textarea
                id="edit-desc"
                value={editForm.description}
                onChange={(e) =>
                  setEditFormOverrides((f) => ({ ...f, description: e.target.value }))
                }
                rows={2}
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="edit-public"
                checked={editForm.is_public}
                onCheckedChange={(v) =>
                  setEditFormOverrides((f) => ({ ...f, is_public: v }))
                }
              />
              <Label htmlFor="edit-public">Public repository</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-quota">Storage Quota</Label>
              <div className="flex gap-2">
                <Input
                  id="edit-quota"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="No limit"
                  value={editQuotaValue}
                  onChange={(e) => setEditQuotaOverrides((o) => ({ ...o, value: e.target.value }))}
                  className="flex-1"
                />
                <Select
                  value={editQuotaUnit}
                  onValueChange={(v) => setEditQuotaOverrides((o) => ({ ...o, unit: v as QuotaUnit }))}
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MB">MB</SelectItem>
                    <SelectItem value="GB">GB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                Maximum storage for this repository. Leave empty for no limit.
              </p>
            </div>

            {editRepo?.format === "debian" &&
              (editRepo.repo_type === "local" || editRepo.repo_type === "remote") && (
                <>
                  {editRepo.repo_type === "remote" && (
                    <div className="space-y-2">
                      <Label htmlFor="edit-debian-upstream">Upstream URL</Label>
                      <Input
                        id="edit-debian-upstream"
                        type="url"
                        value={editDebianUpstreamUrl}
                        onChange={(event) =>
                          setEditDebianUpstreamOverride(event.target.value)
                        }
                        placeholder="https://deb.debian.org/debian"
                        required
                      />
                    </div>
                  )}
                  <DebianConfigFields
                    idPrefix="edit"
                    values={editDebianForm}
                    onChange={setEditDebianOverrides}
                    enabled={editDebianEnabled}
                    onEnabledChange={setEditDebianEnabledOverride}
                    isRemote={editRepo.repo_type === "remote"}
                  />
                </>
              )}

            {/* Upstream authentication for remote repos (saved separately from main form) */}
            {editRepo?.repo_type === "remote" && (
              <div className="space-y-3 border-t pt-4">
                <Label>Upstream Authentication</Label>
                <p className="text-xs text-muted-foreground">
                  Credentials are stored encrypted and saved separately from other repository settings.
                </p>

                {/*
                  #410: Announce the outcome of the upstream-auth save to
                  assistive technology. The save resolves via a parent mutation
                  whose only feedback was a visual toast; this polite live
                  region (role="status") gives screen-reader users the result
                  inside the dialog where their focus already is. The error
                  case uses role="alert" semantics via aria-live="assertive".
                */}
                <div
                  data-testid="upstream-auth-status"
                  role={upstreamAuthStatus.state === "error" ? "alert" : "status"}
                  aria-live={upstreamAuthStatus.state === "error" ? "assertive" : "polite"}
                  className={
                    upstreamAuthStatus.state === "error"
                      ? "text-sm text-destructive"
                      : "text-sm text-emerald-600 dark:text-emerald-500"
                  }
                >
                  {upstreamAuthStatus.state !== "idle" && upstreamAuthStatus.message
                    ? upstreamAuthStatus.message
                    : ""}
                </div>

                {editAuthMode === "view" ? (
                  <div className="space-y-2">
                    {editRepo.upstream_auth_configured ? (
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-muted-foreground">
                          Authentication configured ({editRepo.upstream_auth_type === "basic" ? "Basic Auth" : editRepo.upstream_auth_type === "bearer" ? "Bearer Token" : editRepo.upstream_auth_type})
                        </p>
                        <div className="flex gap-2">
                          <Button
                            id="edit-upstream-auth-toggle"
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditAuthMode("edit");
                              setEditAuthType(editRepo.upstream_auth_type ?? "basic");
                            }}
                          >
                            Change
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={upstreamAuthPending || removeAuthConfirm}
                            onClick={() => setRemoveAuthConfirm(true)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-muted-foreground">
                          No authentication configured
                        </p>
                        <Button
                          id="edit-upstream-auth-toggle"
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setEditAuthMode("edit")}
                        >
                          Configure
                        </Button>
                      </div>
                    )}
                    {removeAuthConfirm && (
                      <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/5 p-2">
                        <p className="text-xs text-destructive flex-1">
                          Removing credentials will cause upstream requests to fail if the registry requires authentication.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setRemoveAuthConfirm(false)}
                        >
                          Keep
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={upstreamAuthPending}
                          onClick={() => {
                            if (onUpstreamAuthUpdate) {
                              onUpstreamAuthUpdate(editRepo.key, { auth_type: "none" });
                            }
                            setRemoveAuthConfirm(false);
                          }}
                        >
                          Confirm Remove
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Label htmlFor="edit-upstream-auth-type">Authentication type</Label>
                    <Select value={editAuthType} onValueChange={setEditAuthType}>
                      <SelectTrigger
                        className="w-full"
                        id="edit-upstream-auth-type"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="basic">Basic (username + password)</SelectItem>
                        <SelectItem value="bearer">Bearer token</SelectItem>
                      </SelectContent>
                    </Select>

                    {editAuthType === "basic" && (
                      <>
                        <Label htmlFor="edit-upstream-username">Username</Label>
                        <Input
                          id="edit-upstream-username"
                          placeholder="Username"
                          required
                          value={editAuthUsername}
                          onChange={(e) => setEditAuthUsername(e.target.value)}
                          autoComplete="off"
                        />
                        <Label htmlFor="edit-upstream-password">Password</Label>
                        <Input
                          id="edit-upstream-password"
                          type="password"
                          placeholder="Password or access token"
                          required
                          value={editAuthPassword}
                          onChange={(e) => setEditAuthPassword(e.target.value)}
                          autoComplete="off"
                        />
                      </>
                    )}

                    {editAuthType === "bearer" && (
                      <>
                        <Label htmlFor="edit-upstream-token">Token</Label>
                        <Input
                          id="edit-upstream-token"
                          type="password"
                          placeholder="Bearer token"
                          required
                          value={editAuthPassword}
                          onChange={(e) => setEditAuthPassword(e.target.value)}
                          autoComplete="off"
                        />
                      </>
                    )}

                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditAuthMode("view");
                          setEditAuthType("none");
                          setEditAuthUsername("");
                          setEditAuthPassword("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          upstreamAuthPending ||
                          (editAuthType !== "none" && !editAuthPassword) ||
                          (editAuthType === "basic" && !editAuthUsername)
                        }
                        onClick={() => {
                          if (onUpstreamAuthUpdate && editRepo) {
                            const payload: { auth_type: string; username?: string; password?: string } = {
                              auth_type: editAuthType,
                            };
                            if (editAuthType === "basic") {
                              payload.username = editAuthUsername;
                              payload.password = editAuthPassword;
                            } else if (editAuthType === "bearer") {
                              payload.password = editAuthPassword;
                            }
                            onUpstreamAuthUpdate(editRepo.key, payload);
                          }
                        }}
                      >
                        {upstreamAuthPending ? "Saving..." : "Save Authentication"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onEditOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={editPending}>
                {editPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* -- Delete Confirm Dialog -- */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={onDeleteOpenChange}
        title="Delete Repository"
        description={`Deleting "${deleteRepo?.key}" will permanently remove all artifacts and metadata. This action cannot be undone.`}
        typeToConfirm={deleteRepo?.key}
        confirmText="Delete Repository"
        danger
        loading={deletePending}
        onConfirm={() => {
          if (deleteRepo) onDeleteConfirm(deleteRepo.key);
        }}
      />
    </>
  );
}
