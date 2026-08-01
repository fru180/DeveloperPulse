import type { Metadata } from "next";
import { DeveloperPulse } from "./DeveloperPulse";

export const metadata: Metadata = {
  title: "DeveloperPulse — System audio, visualized",
  description:
    "A private, local-first system audio visualizer inspired by the GitHub contribution graph.",
};

export default function Home() {
  return <DeveloperPulse />;
}
