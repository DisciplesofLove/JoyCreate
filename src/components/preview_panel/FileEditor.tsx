import React, { useState, useRef, useEffect } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import { useLoadAppFile } from "@/hooks/useLoadAppFile";
import { useTheme } from "@/contexts/ThemeContext";
import { ChevronRight, Circle, Save } from "lucide-react";
import "@/components/chat/monaco";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showSuccess, showWarning } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings } from "@/hooks/useSettings";
import { useCheckProblems } from "@/hooks/useCheckProblems";
import { getLanguage } from "@/utils/get_language";
import { useGeniusCoreEditLogger } from "@/hooks/useGeniusCoreEditLogger";
import type { editor as MonacoEditor } from "monaco-editor";

interface FileEditorProps {
  appId: number | null;
  filePath: string;
}

interface BreadcrumbProps {
  path: string;
  hasUnsavedChanges: boolean;
  onSave: () => void;
  isSaving: boolean;
}

const Breadcrumb: React.FC<BreadcrumbProps> = ({
  path,
  hasUnsavedChanges,
  onSave,
  isSaving,
}) => {
  const segments = path.split("/").filter(Boolean);

  return (
    <div className="flex items-center justify-between px-4 py-2 text-sm text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-1 overflow-hidden">
        <div className="flex items-center gap-1 overflow-hidden min-w-0">
          {segments.map((segment, index) => (
            <React.Fragment key={index}>
              {index > 0 && (
                <ChevronRight
                  size={14}
                  className="text-gray-400 flex-shrink-0"
                />
              )}
              <span className="hover:text-gray-900 dark:hover:text-gray-100 cursor-pointer truncate">
                {segment}
              </span>
            </React.Fragment>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSave}
                disabled={!hasUnsavedChanges || isSaving}
                className="h-6 w-6 p-0"
                data-testid="save-file-button"
              >
                <Save size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {hasUnsavedChanges ? "Save changes" : "No unsaved changes"}
            </TooltipContent>
          </Tooltip>
          {hasUnsavedChanges && (
            <Circle
              size={8}
              fill="currentColor"
              className="text-amber-600 dark:text-amber-400"
            />
          )}
        </div>
      </div>
    </div>
  );
};

export const FileEditor = ({ appId, filePath }: FileEditorProps) => {
  const { content, loading, error } = useLoadAppFile(appId, filePath);
  const { theme } = useTheme();
  const [value, setValue] = useState<string | undefined>(undefined);
  const [displayUnsavedChanges, setDisplayUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { settings } = useSettings();
  // Use refs for values that need to be current in event handlers
  const originalValueRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<any>(null);
  const isSavingRef = useRef<boolean>(false);
  const needsSaveRef = useRef<boolean>(false);
  const currentValueRef = useRef<string | undefined>(undefined);

  const queryClient = useQueryClient();
  const { checkProblems } = useCheckProblems(appId);

  // Genius Core — order-respecting edit capture. The hook no-ops unless the
  // user has opted into telemetry AND enabled the keystroke logger (the main
  // process enforces the privacy gate on every record), so this is safe to
  // wire unconditionally here.
  const { recordTextChange } = useGeniusCoreEditLogger({
    projectId: appId,
    fileId: filePath,
  });

  // Update state when content loads
  useEffect(() => {
    if (content !== null) {
      setValue(content);
      originalValueRef.current = content;
      currentValueRef.current = content;
      needsSaveRef.current = false;
      setDisplayUnsavedChanges(false);
      setIsSaving(false);
    }
  }, [content, filePath]);

  // Sync the UI with the needsSave ref
  useEffect(() => {
    setDisplayUnsavedChanges(needsSaveRef.current);
  }, [needsSaveRef.current]);

  // Determine if dark mode based on theme
  const isDarkMode =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const editorTheme = isDarkMode ? "joy-dark" : "joy-light";

  // Handle editor mount
  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;

    // Listen for model content change events
    editor.onDidBlurEditorText(() => {
      console.log("Editor text blurred, checking if save needed");
      if (needsSaveRef.current) {
        saveFile();
      }
    });
  };

  // Handle content change
  const handleEditorChange = (
    newValue: string | undefined,
    ev?: MonacoEditor.IModelContentChangedEvent,
  ) => {
    setValue(newValue);
    currentValueRef.current = newValue;

    const hasChanged = newValue !== originalValueRef.current;
    needsSaveRef.current = hasChanged;
    setDisplayUnsavedChanges(hasChanged);

    // Best-effort Genius Core capture: translate each Monaco change into an
    // insert/delete record with its range. Never allow capture to disrupt the
    // editor hot path.
    if (ev?.changes?.length) {
      try {
        for (const change of ev.changes) {
          const range = {
            startLine: change.range.startLineNumber,
            startCol: change.range.startColumn,
            endLine: change.range.endLineNumber,
            endCol: change.range.endColumn,
          };
          if (change.text.length > 0) {
            void recordTextChange("insert", range, change.text);
          } else if (change.rangeLength > 0) {
            void recordTextChange("delete", range, "");
          }
        }
      } catch {
        // capture is best-effort; swallow any failure
      }
    }
  };

  // Save the file
  const saveFile = async () => {
    if (
      !appId ||
      !currentValueRef.current ||
      !needsSaveRef.current ||
      isSavingRef.current
    )
      return;

    try {
      isSavingRef.current = true;
      setIsSaving(true);

      const ipcClient = IpcClient.getInstance();
      const { warning } = await ipcClient.editAppFile(
        appId,
        filePath,
        currentValueRef.current,
      );
      await queryClient.invalidateQueries({ queryKey: ["versions", appId] });
      if (settings?.enableAutoFixProblems) {
        checkProblems();
      }
      if (warning) {
        showWarning(warning);
      } else {
        showSuccess("File saved");
      }

      originalValueRef.current = currentValueRef.current;
      needsSaveRef.current = false;
      setDisplayUnsavedChanges(false);
    } catch (error) {
      showError(error);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  if (loading) {
    return <div className="p-4">Loading file content...</div>;
  }

  if (error) {
    return <div className="p-4 text-red-500">Error: {error.message}</div>;
  }

  if (!content) {
    return <div className="p-4 text-gray-500">No content available</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <Breadcrumb
        path={filePath}
        hasUnsavedChanges={displayUnsavedChanges}
        onSave={saveFile}
        isSaving={isSaving}
      />
      <div className="flex-1 overflow-hidden">
        <Editor
          height="100%"
          defaultLanguage={getLanguage(filePath)}
          value={value}
          theme={editorTheme}
          onChange={handleEditorChange}
          onMount={handleEditorDidMount}
          options={{
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            fontFamily: "monospace",
            fontSize: 13,
            lineNumbers: "on",
          }}
        />
      </div>
    </div>
  );
};
