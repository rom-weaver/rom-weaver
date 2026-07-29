import { createElement } from "preact";

// Lucide's CommonJS entry requires React before Vitest can apply Vite aliases.
// Unit tests only need the icon boundary; browser tests exercise the real SVGs.
const Icon = (props) => createElement("svg", { viewBox: "0 0 24 24", ...props });
const createLucideIcon = () => Icon;

export {
  Icon as Archive,
  Icon as ArrowLeftRight,
  Icon as ArrowUpDown,
  Icon as BookOpen,
  Icon as Check,
  Icon as ChevronDown,
  Icon as ChevronRight,
  Icon as ChevronUp,
  Icon as CircleX,
  Icon as Copy,
  Icon as Crosshair,
  Icon as Disc3,
  Icon as Download,
  Icon as EllipsisVertical,
  Icon as GitCompare,
  Icon as Heart,
  Icon as House,
  Icon as Info,
  Icon as ListChecks,
  Icon as Moon,
  Icon as Package,
  Icon as Pencil,
  Icon as Plus,
  Icon as RefreshCw,
  Icon as RotateCcw,
  Icon as Save,
  Icon as Scissors,
  Icon as ScrollText,
  Icon as Settings,
  Icon as SlidersHorizontal,
  Icon as SunMedium,
  Icon as Tag,
  Icon as ToggleRight,
  Icon as Trash2,
  Icon as TriangleAlert,
  Icon as Upload,
  Icon as UserRound,
  Icon as Wrench,
  Icon as X,
  createLucideIcon,
};
