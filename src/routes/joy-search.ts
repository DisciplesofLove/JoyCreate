import { createRoute } from "@tanstack/react-router";
import { z } from "zod";
import { rootRoute } from "./root";
import JoySearchPage from "@/pages/JoySearchPage";

const searchSchema = z.object({
  q: z.string().optional(),
});

export const joySearchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/joy-search",
  validateSearch: searchSchema,
  component: JoySearchPage,
});
