import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { CommandBar } from "@/components/command/CommandBar";
import { Toaster } from "@/components/lo/Toast";
import { RemoteBackupPrompt } from "@/components/backup/RemoteBackupPrompt";
import { TaskPeek } from "@/components/tasks/TaskPeek";

export function AppLayout() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <TaskPeek />
      <CommandBar />
      <Toaster />
      <RemoteBackupPrompt />
    </div>
  );
}
