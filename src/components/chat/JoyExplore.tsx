import type React from "react";
import type { ReactNode } from "react";
import { Telescope, Loader } from "lucide-react";
import { CustomTagState } from "./stateTypes";

interface JoyExploreProps {
  children?: ReactNode;
  node?: any;
  query?: string;
}

export const JoyExplore: React.FC<JoyExploreProps> = ({
  children,
  node,
  query: queryProp,
}) => {
  const state = node?.properties?.state as CustomTagState;
  const inProgress = state === "pending";
  const query =
    queryProp ||
    node?.properties?.query ||
    (typeof children === "string" ? children : "");

  return (
    <div className="bg-(--background-lightest) rounded-lg px-4 py-2 border my-2">
      <div className="flex items-center gap-2">
        <Telescope size={16} className="text-violet-600" />
        <div className="text-xs text-violet-600 font-medium">
          Exploring codebase
        </div>
        {inProgress && (
          <Loader size={12} className="animate-spin text-violet-500" />
        )}
      </div>
      {query && (
        <div className="text-sm italic text-gray-600 dark:text-gray-300 mt-2">
          {query}
        </div>
      )}
    </div>
  );
};
