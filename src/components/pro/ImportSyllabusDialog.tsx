import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Sparkles } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/lo/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MODELS, errorText, fileToBase64, useAiKey, useIntakeExtract, useProModel, useProStatus } from "@/hooks/usePro";
import { commands } from "@/lib/commands";
import type { Context } from "@/types";

const ACCEPT = ".pdf,.docx,.txt,.md";
const MAX_BYTES = 20 * 1024 * 1024;

function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCents(cents: number) {
  if (cents < 1) return "under 1¢";
  return `about ${Math.round(cents)}¢`;
}

function UpgradeCard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { data: status } = useProStatus();
  const ended = status?.state === "revoked" || status?.state === "check_needed";
  const activatedOnFree = status && !status.pro_build && (status.state === "active" || status.state === "grace");
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand" />
          Import a syllabus
        </DialogTitle>
        <DialogDescription>
          {ended
            ? "Your Schedu Pro licence needs attention before you can import."
            : activatedOnFree
              ? "Your key is active. Install the Pro version from Settings to start importing."
              : "Part of Schedu Pro."}
        </DialogDescription>
      </DialogHeader>
      {!ended && !activatedOnFree && (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-fg2">
          <li>Drop in a PDF or Word syllabus. Every assignment, quiz and exam is read into this class, with grade weights and the instructor.</li>
          <li>You check each row before anything is added. Missing or odd dates are flagged, never guessed.</li>
          <li>Undo a whole import with one click.</li>
          <li>Runs on your own Anthropic API key, so you pay a few cents per syllabus and your files go only to Anthropic.</li>
        </ul>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        {!ended && !activatedOnFree && <SecondaryButton onClick={() => void commands.proOpenLink("learn")}>Learn more</SecondaryButton>}
        {status?.on_sale && !ended && !activatedOnFree && (
          <SecondaryButton onClick={() => void commands.proOpenLink("buy")}>Get Schedu Pro</SecondaryButton>
        )}
        <PrimaryButton
          onClick={() => {
            onClose();
            navigate("/settings?section=pro");
          }}
        >
          {ended || activatedOnFree ? "Open Settings" : "I have a key"}
        </PrimaryButton>
      </div>
    </>
  );
}

function Picker({ context, onClose }: { context: Context; onClose: () => void }) {
  const navigate = useNavigate();
  const model = useProModel();
  const extract = useIntakeExtract();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setEstimate(null);
    if (!file) return;
    let cancelled = false;
    commands.intakeEstimateCost(file.name, file.size, model).then((c) => !cancelled && setEstimate(c));
    return () => {
      cancelled = true;
    };
  }, [file, model]);

  const choose = (f: File | undefined) => {
    setLocalError(null);
    extract.reset();
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setLocalError("That file is too large. Syllabus files up to 20 MB are supported.");
      return;
    }
    setFile(f);
  };

  const start = async () => {
    if (!file) return;
    const fileBase64 = await fileToBase64(file);
    extract.mutate(
      { contextId: context.id, fileName: file.name, fileBase64 },
      {
        onSuccess: (batch) => {
          onClose();
          navigate(`/school/${context.id}/import/${batch.id}`);
        },
      },
    );
  };

  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model;
  const error = localError ?? (extract.error ? errorText(extract.error) : null);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Import a syllabus</DialogTitle>
        <DialogDescription>Rows are added to {context.name} only after you review them.</DialogDescription>
      </DialogHeader>

      <button
        type="button"
        disabled={extract.isPending}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          choose(e.dataTransfer.files[0]);
        }}
        className="flex min-h-[120px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line2 bg-sunken/50 px-4 py-6 text-center text-[13.5px] text-fg2 hover:bg-hover disabled:opacity-60"
      >
        <FileText className="size-5 text-fg3" />
        {file ? (
          <span>
            <span className="font-medium text-foreground">{file.name}</span> · {formatSize(file.size)}
          </span>
        ) : (
          <span>Choose or drop a PDF, Word (.docx) or text file</span>
        )}
      </button>
      <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => choose(e.target.files?.[0])} />

      {file && (
        <p className="text-[12.5px] leading-snug text-fg3">
          This file will be sent to Anthropic using your API key and read with {modelLabel}
          {estimate != null && <>, {formatCents(estimate)} on your Anthropic account</>}. Schedu doesn't keep a copy.
        </p>
      )}
      {error && <p className="text-[13px] text-danger">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <SecondaryButton onClick={onClose} disabled={extract.isPending}>
          Cancel
        </SecondaryButton>
        <PrimaryButton onClick={() => void start()} disabled={!file || extract.isPending}>
          {extract.isPending ? "Reading… usually under a minute" : "Read syllabus"}
        </PrimaryButton>
      </div>
    </>
  );
}

function NeedsKey({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add your Anthropic API key</DialogTitle>
        <DialogDescription>Syllabus import runs on your own Anthropic account. It takes about two minutes to set up.</DialogDescription>
      </DialogHeader>
      <div className="flex justify-end gap-2 pt-2">
        <SecondaryButton onClick={onClose}>Not now</SecondaryButton>
        <PrimaryButton
          onClick={() => {
            onClose();
            navigate("/settings?section=pro");
          }}
        >
          Open Settings
        </PrimaryButton>
      </div>
    </>
  );
}

export function ImportSyllabusDialog({ open, onOpenChange, context }: { open: boolean; onOpenChange: (open: boolean) => void; context: Context }) {
  const { data: status } = useProStatus();
  const { data: aiKey } = useAiKey();
  const ready = !!status?.pro_build && (status.state === "active" || status.state === "grace");
  const close = () => onOpenChange(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg space-y-4">
        {!ready ? <UpgradeCard onClose={close} /> : !aiKey?.saved ? <NeedsKey onClose={close} /> : <Picker context={context} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}
