import type React from "react";
import type { ReactNode } from "react";
import { Files } from "lucide-react";

interface JoyCopyProps {
  children?: ReactNode;
  node?: any;
  from?: string;
  to?: string;
}

export const JoyCopy: React.FC<JoyCopyProps> = ({
  node,
  from: fromProp,
  to: toProp,
}) => {
  const from = fromProp || node?.properties?.from || "";
  const to = toProp || node?.properties?.to || "";

  const fromFileName = from ? from.split("/").pop() : "";
  const toFileName = to ? to.split("/").pop() : "";

  return (
    <div className="bg-(--background-lightest) rounded-lg px-4 py-2 border border-sky-500 my-2">
      <div className="flex items-center gap-2">
        <Files size={16} className="text-sky-500" />
        {(fromFileName || toFileName) && (
          <span className="text-gray-700 dark:text-gray-300 font-medium text-sm">
            {fromFileName && toFileName
              ? `${fromFileName} → ${toFileName}`
              : fromFileName || toFileName}
          </span>
        )}
        <div className="text-xs text-sky-500 font-medium">Copy</div>
      </div>
    </div>
  );
};
