import { createContext, type ReactNode } from "react";

/** A page's own disclosure for the empty hero's help row, shown after "Supported formats". */
const HeroDetailsContext = createContext<ReactNode>(null);

export { HeroDetailsContext };
