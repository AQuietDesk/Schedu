import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { useThemeEffect } from "@/hooks/useTheme";
import { useFocusStore } from "@/store/focusStore";
import Today from "@/pages/Today";
import Tasks from "@/pages/Tasks";
import ClassPage from "@/pages/ClassPage";
import CalendarPage from "@/pages/Calendar";
import Focus from "@/pages/Focus";
import Stats from "@/pages/Stats";
import Settings from "@/pages/Settings";

function App() {
  useThemeEffect();

  // Resumes an in-progress focus/break session across app relaunches — the
  // timer itself is DB-persisted (see focusStore.ts), this just loads it in.
  useEffect(() => {
    void useFocusStore.getState().hydrate();
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Today />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="school/:contextId" element={<ClassPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="focus" element={<Focus />} />
          <Route path="stats" element={<Stats />} />
          <Route path="settings" element={<Settings />} />
          {/* Old routes from before the redesign (bookmarks, notification deep links). */}
          <Route path="master-list" element={<Navigate to="/tasks" replace />} />
          <Route path="personal" element={<Navigate to="/tasks?area=Personal" replace />} />
          <Route path="school" element={<Navigate to="/tasks?area=School" replace />} />
          <Route path="statistics" element={<Navigate to="/stats" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

export default App;
