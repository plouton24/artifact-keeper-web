"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type {
  Repository,
  CreateRepositoryRequest,
  DebianRepositoryConfig,
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
  distributions: string;
  suite: string;
  codename: string;
  releaseDescription: string;
  components: string;
  architectures: string;
  signingEnabled: boolean;
  signingKeyId: string;
  cachePolicy: "metadata_ttl" | "always_revalidate" | "no_cache";
  downloadPolicy: "on_demand" | "immediate";
  reSign: boolean;
}

const EMPTY_DEBIAN_FORM: DebianFormValues = {
  distributions: "",
  suite: "",
  codename: "",
  releaseDescription: "",
  components: "",
  architectures: "",
  signingEnabled: false,
  signingKeyId: "",
  cachePolicy: "metadata_ttl",
  downloadPolicy: "on_demand",
  reSign: false,
};

const DEBIAN_IDENTIFIER_LIST_PATTERN =
  "[A-Za-z0-9._+\\-]+(?:\\s*,\\s*[A-Za-z0-9._+\\-]+)*";
const DEBIAN_IDENTIFIER_PATTERN = "[A-Za-z0-9._+\\-]+";

function splitDebianIdentifiers(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function debianConfigToForm(config?: DebianRepositoryConfig): DebianFormValues {
  return {
    distributions: config?.distributions.join(", ") ?? "",
    suite: config?.suite ?? "",
    codename: config?.codename ?? "",
    releaseDescription: config?.description ?? "",
    components: config?.components.join(", ") ?? "",
    architectures: config?.architectures.join(", ") ?? "",
    signingEnabled: config?.signing_enabled ?? false,
    signingKeyId: config?.signing_key_id ?? "",
    cachePolicy:
      config?.sync?.cache_policy === "always_revalidate" ||
      config?.sync?.cache_policy === "no_cache"
        ? config.sync.cache_policy
        : "metadata_ttl",
    downloadPolicy:
      config?.sync?.download_policy === "immediate" ? "immediate" : "on_demand",
    reSign: config?.sync?.re_sign ?? false,
  };
}

function buildDebianConfig(
  values: DebianFormValues,
  isRemote: boolean,
  upstreamUrl?: string,
): DebianRepositoryConfig {
  const distributions = splitDebianIdentifiers(values.distributions);
  const components = splitDebianIdentifiers(values.components);
  const architectures = splitDebianIdentifiers(values.architectures);
  const normalizedUpstream = upstreamUrl?.trim() || undefined;

  return {
    distributions,
    suite: values.suite.trim() || undefined,
    codename: values.codename.trim() || undefined,
    description: values.releaseDescription.trim() || undefined,
    components,
    architectures,
    signing_enabled: values.signingEnabled,
    signing_key_id: values.signingKeyId.trim() || undefined,
    upstream_base_url: isRemote ? normalizedUpstream : undefined,
    sync: isRemote
      ? {
          base_url: normalizedUpstream,
          distributions,
          components,
          architectures,
          cache_policy: values.cachePolicy,
          download_policy: values.downloadPolicy,
          re_sign: values.reSign,
        }
      : undefined,
  };
}

interface DebianConfigFieldsProps {
  idPrefix: "create" | "edit";
  values: DebianFormValues;
  onChange: (values: DebianFormValues) => void;
  isRemote: boolean;
}

function DebianConfigFields({
  idPrefix,
  values,
  onChange,
  isRemote,
}: DebianConfigFieldsProps) {
  const update = <K extends keyof DebianFormValues>(
    key: K,
    value: DebianFormValues[K],
  ) => onChange({ ...values, [key]: value });

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div>
        <h3 className="text-sm font-semibold">Debian/APT configuration</h3>
        <p className="text-xs text-muted-foreground">
          Configure Release metadata, package layout, and APT client filters.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-debian-distributions`}>Distributions</Label>
        <Input
          id={`${idPrefix}-debian-distributions`}
          placeholder="bookworm, bookworm-updates"
          value={values.distributions}
          onChange={(event) => update("distributions", event.target.value)}
          pattern={DEBIAN_IDENTIFIER_LIST_PATTERN}
          required
        />
        <p className="text-xs text-muted-foreground">Comma-separated suites or codenames.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-debian-suite`}>Suite</Label>
          <Input
            id={`${idPrefix}-debian-suite`}
            placeholder="stable"
            value={values.suite}
            onChange={(event) => update("suite", event.target.value)}
            pattern={DEBIAN_IDENTIFIER_PATTERN}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-debian-codename`}>Codename</Label>
          <Input
            id={`${idPrefix}-debian-codename`}
            placeholder="bookworm"
            value={values.codename}
            onChange={(event) => update("codename", event.target.value)}
            pattern={DEBIAN_IDENTIFIER_PATTERN}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-debian-components`}>Components</Label>
          <Input
            id={`${idPrefix}-debian-components`}
            placeholder="main, contrib, non-free"
            value={values.components}
            onChange={(event) => update("components", event.target.value)}
            pattern={DEBIAN_IDENTIFIER_LIST_PATTERN}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-debian-architectures`}>Architectures</Label>
          <Input
            id={`${idPrefix}-debian-architectures`}
            placeholder="amd64, arm64, all"
            value={values.architectures}
            onChange={(event) => update("architectures", event.target.value)}
            pattern={DEBIAN_IDENTIFIER_LIST_PATTERN}
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-debian-release-description`}>
          Release description
        </Label>
        <Input
          id={`${idPrefix}-debian-release-description`}
          placeholder="Internal Debian package repository"
          value={values.releaseDescription}
          onChange={(event) => update("releaseDescription", event.target.value)}
        />
      </div>

      {isRemote && (
        <div className="space-y-4 border-t pt-4">
          <div>
            <h4 className="text-sm font-medium">Remote cache and sync</h4>
            <p className="text-xs text-muted-foreground">
              Metadata cache behavior and when packages are mirrored from upstream.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-debian-cache-policy`}>Metadata access</Label>
              <Select
                value={values.cachePolicy}
                onValueChange={(value) =>
                  update("cachePolicy", value as DebianFormValues["cachePolicy"])
                }
              >
                <SelectTrigger id={`${idPrefix}-debian-cache-policy`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="metadata_ttl">Use metadata cache</SelectItem>
                  <SelectItem value="always_revalidate">Always revalidate upstream</SelectItem>
                  <SelectItem value="no_cache">Direct metadata (no cache)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-debian-download-policy`}>Package download</Label>
              <Select
                value={values.downloadPolicy}
                onValueChange={(value) =>
                  update("downloadPolicy", value as DebianFormValues["downloadPolicy"])
                }
              >
                <SelectTrigger id={`${idPrefix}-debian-download-policy`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="on_demand">On demand (pull-through cache)</SelectItem>
                  <SelectItem value="immediate">Immediate mirror sync</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id={`${idPrefix}-debian-resign`}
              checked={values.reSign}
              onCheckedChange={(checked) => update("reSign", checked)}
            />
            <div>
              <Label htmlFor={`${idPrefix}-debian-resign`}>Re-sign mirrored metadata</Label>
              <p className="text-xs text-muted-foreground">
                Sign locally generated Release metadata after filtering upstream content.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 border-t pt-4">
        <Switch
          id={`${idPrefix}-debian-signing`}
          checked={values.signingEnabled}
          onCheckedChange={(checked) => update("signingEnabled", checked)}
        />
        <Label htmlFor={`${idPrefix}-debian-signing`}>Sign Release metadata</Label>
      </div>
      {values.signingEnabled && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-debian-signing-key`}>Signing key ID</Label>
          <Input
            id={`${idPrefix}-debian-signing-key`}
            placeholder="Existing signing key UUID (optional)"
            value={values.signingKeyId}
            onChange={(event) => update("signingKeyId", event.target.value)}
          />
        </div>
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
    () => debianConfigToForm(editRepo?.debian_config),
    [editRepo],
  );
  const editDebianForm = { ...editDebianDefaults, ...editDebianOverrides };
  const editDebianUpstreamUrl =
    editDebianUpstreamOverride ??
    editRepo?.debian_config?.upstream_base_url ??
    editRepo?.upstream_url ??
    "";
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
                debian_config:
                  createForm.format === "debian" &&
                  (createForm.repo_type === "local" || createForm.repo_type === "remote")
                    ? buildDebianConfig(
                        createDebianForm,
                        createForm.repo_type === "remote",
                        createForm.upstream_url,
                      )
                    : undefined,
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
                  ...(editRepo.format === "debian" &&
                  (editRepo.repo_type === "local" || editRepo.repo_type === "remote")
                    ? {
                        upstream_url:
                          editRepo.repo_type === "remote"
                            ? editDebianUpstreamUrl.trim()
                            : undefined,
                        debian_config: buildDebianConfig(
                          editDebianForm,
                          editRepo.repo_type === "remote",
                          editDebianUpstreamUrl,
                        ),
                      }
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
