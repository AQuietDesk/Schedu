import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function QueryBoundary({
  isLoading,
  isError,
  error,
  onRetry,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (isLoading) {
    return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  }

  if (isError) {
    const message = error instanceof Error ? error.message : "Something went wrong loading this page.";
    return (
      <div className="space-y-2 p-8 text-sm">
        <p className="text-destructive">{message}</p>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  return <>{children}</>;
}
