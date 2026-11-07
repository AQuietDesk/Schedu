import { useState } from "react";
import { Check, Download, ExternalLink } from "lucide-react";
import { PrimaryButton, Segmented, SecondaryButton } from "@/components/lo/primitives";
import { Group, SettingRow } from "@/components/settings/SettingsAtoms";
import { Input } from "@/components/ui/input";
import { useSetPreference } from "@/hooks/usePreferences";
import {
  MODEL_PREF_KEY,
  MODELS,
  errorText,
  useActivatePro,
  useAiKey,
  useDeactivatePro,
  useInstallProUpgrade,
  useProModel,
  useProStatus,
  useRecheckPro,
  useRemoveAiKey,
  useSaveAiKey,
  useTestAiKey,
} from "@/hooks/usePro";
import { commands } from "@/lib/commands";
import type { ProStatus } from "@/types";

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

function LinkButton({ which, children }: { which: Parameters<typeof commands.proOpenLink>[0]; children: React.ReactNode }) {
  return (
    <button type="button" onClick={() => void commands.proOpenLink(which)} className="inline-flex items-center gap-1 text-brand underline-offset-2 hover:underline">
      {children}
      <ExternalLink className="size-3" />
    </button>
  );
}

function stateLine(s: ProStatus): { text: string; tone?: "danger" } {
  switch (s.state) {
    case "active":
      return { text: `Active · checked ${fmtDate(s.last_checked)}` };
    case "grace":
      return { text: `Offline · keeps working until ${fmtDate(s.grace_until)}. Connect to the internet to re-check.` };
    case "check_needed":
      return { text: "Needs a check. Connect to the internet, then press Check now.", tone: "danger" };
    case "revoked":
      return { text: "Your subscription has ended. Renew to turn Pro back on. Imported items stay.", tone: "danger" };
    default:
      return { text: "" };
  }
}

function Licence({ status }: { status: ProStatus }) {
  const [key, setKey] = useState("");
  const activate = useActivatePro();
  const recheck = useRecheckPro();
  const deactivate = useDeactivatePro();
  const install = useInstallProUpgrade();
  const error = activate.error ?? recheck.error ?? deactivate.error ?? install.error;
  const unlocked = status.state === "active" || status.state === "grace";

  if (status.state === "inactive") {
    return (
      <Group
        title="Schedu Pro"
        footer={
          error ? (
            <span className="text-danger">{errorText(error)}</span>
          ) : (
            "After you buy, your licence key is in the receipt email and on your Polar purchases page."
          )
        }
      >
        <SettingRow
          label="Syllabus import"
          description={
            status.on_sale
              ? "Drop in a syllabus and every deadline, exam and grade weight lands in the class, ready to review. Yearly subscription."
              : "Drop in a syllabus and every deadline, exam and grade weight lands in the class. Coming soon."
          }
        >
          <SecondaryButton onClick={() => void commands.proOpenLink("learn")}>Learn more</SecondaryButton>
          {status.on_sale && <PrimaryButton onClick={() => void commands.proOpenLink("buy")}>Get Schedu Pro</PrimaryButton>}
        </SettingRow>
        {status.on_sale && (
          <form
            className="flex flex-wrap items-center gap-2 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) activate.mutate(key.trim(), { onSuccess: () => setKey("") });
            }}
          >
            <label htmlFor="pro-key" className="text-[14.5px]">
              Licence key
            </label>
            <Input
              id="pro-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Paste your key"
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 font-mono text-[13px]"
            />
            <PrimaryButton type="submit" disabled={!key.trim() || activate.isPending}>
              {activate.isPending ? "Activating…" : "Activate"}
            </PrimaryButton>
          </form>
        )}
      </Group>
    );
  }

  const line = stateLine(status);
  return (
    <Group
      title="Schedu Pro"
      footer={error ? <span className="text-danger">{errorText(error)}</span> : undefined}
    >
      {!status.pro_build && unlocked && (
        <SettingRow
          label="Download Schedu Pro"
          description="Your key is active. Install the Pro version over this one; your data stays where it is and Schedu restarts when it's done."
        >
          <PrimaryButton onClick={() => install.mutate()} disabled={install.isPending}>
            <Download />
            {install.isPending ? "Downloading…" : "Install"}
          </PrimaryButton>
        </SettingRow>
      )}
      <SettingRow
        label={
          <span className="inline-flex items-center gap-2">
            Licence
            {unlocked && status.pro_build && (
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">PRO</span>
            )}
          </span>
        }
        description={
          <>
            <span className="font-mono">{status.key_display}</span> · {status.device_label}
            <br />
            <span className={line.tone === "danger" ? "text-danger" : undefined}>{line.text}</span>
          </>
        }
      >
        <SecondaryButton onClick={() => recheck.mutate(undefined)} disabled={recheck.isPending}>
          {recheck.isPending ? "Checking…" : "Check now"}
        </SecondaryButton>
      </SettingRow>
      <SettingRow label="Subscription" description="Renewal, receipts, and the computers your key is active on.">
        <SecondaryButton onClick={() => void commands.proOpenLink("portal")}>
          Manage
          <ExternalLink />
        </SecondaryButton>
      </SettingRow>
      <SettingRow label="Remove from this PC" description="Frees this computer's slot so you can use the key on another one.">
        <SecondaryButton onClick={() => deactivate.mutate(undefined)} disabled={deactivate.isPending}>
          {deactivate.isPending ? "Removing…" : "Remove"}
        </SecondaryButton>
      </SettingRow>
    </Group>
  );
}

function AiKey() {
  const { data: aiKey } = useAiKey();
  const save = useSaveAiKey();
  const remove = useRemoveAiKey();
  const test = useTestAiKey();
  const model = useProModel();
  const setPreference = useSetPreference();
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const showInput = !aiKey?.saved || replacing;
  const error = save.error ?? remove.error ?? test.error;

  return (
    <>
      <Group
        title="Your Anthropic API key"
        footer={
          error ? (
            <span className="text-danger">{errorText(error)}</span>
          ) : test.isSuccess ? (
            <span className="inline-flex items-center gap-1 text-success">
              <Check className="size-3.5" /> Key works.
            </span>
          ) : (
            <>
              Syllabus reading runs on your own Anthropic account, so you pay Anthropic directly (cents per syllabus) and no one else sees your files. The key is
              kept in Windows Credential Manager, not in Schedu's data or backups, and is only ever sent to Anthropic.
            </>
          )
        }
      >
        <ol className="flex list-decimal flex-col gap-1 py-3 pl-9 pr-4 text-[13.5px] text-fg2">
          <li>
            Create an Anthropic account and add a few dollars of credit: <LinkButton which="anthropic_billing">Billing</LinkButton>
          </li>
          <li>
            Create an API key and copy it: <LinkButton which="anthropic_keys">API keys</LinkButton>
          </li>
          <li>Paste it below, save, then press Test.</li>
        </ol>
        {showInput ? (
          <form
            className="flex flex-wrap items-center gap-2 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              save.mutate(draft.trim(), {
                onSuccess: () => {
                  setDraft("");
                  setReplacing(false);
                  test.reset();
                },
              });
            }}
          >
            <label htmlFor="ai-key" className="text-[14.5px]">
              API key
            </label>
            <Input
              id="ai-key"
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 font-mono text-[13px]"
            />
            <PrimaryButton type="submit" disabled={!draft.trim() || save.isPending}>
              Save
            </PrimaryButton>
            {replacing && <SecondaryButton onClick={() => setReplacing(false)}>Cancel</SecondaryButton>}
          </form>
        ) : (
          <SettingRow label="API key" description={<span className="font-mono">sk-ant-…{aiKey?.last4}</span>}>
            <SecondaryButton onClick={() => test.mutate(model)} disabled={test.isPending}>
              {test.isPending ? "Testing…" : "Test"}
            </SecondaryButton>
            <SecondaryButton onClick={() => setReplacing(true)}>Replace</SecondaryButton>
            <SecondaryButton onClick={() => remove.mutate()} disabled={remove.isPending}>
              Remove
            </SecondaryButton>
          </SettingRow>
        )}
      </Group>

      <Group title="Reading model" footer={MODELS.find((m) => m.id === model)?.hint}>
        <SettingRow label="Model" description="Sonnet reads tricky layouts more reliably. Haiku costs a fraction as much.">
          <Segmented
            label="Model"
            value={model}
            options={MODELS.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(value) => {
              test.reset();
              setPreference.mutate({ key: MODEL_PREF_KEY, value });
            }}
          />
        </SettingRow>
      </Group>
    </>
  );
}

export function ProSettings() {
  const { data: status, error } = useProStatus();
  if (error) return <p className="ml-1 text-[13px] text-danger">{errorText(error)}</p>;
  if (!status) return null;
  return (
    <>
      <Licence status={status} />
      {status.pro_build && <AiKey />}
      <p className="ml-1 text-[12.5px] text-fg3">
        What Schedu Pro sends and where: <LinkButton which="privacy">privacy policy</LinkButton>
      </p>
    </>
  );
}
