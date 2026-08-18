"use client";

import { useState } from "react";

import { SegmentedControl } from "@/components/ui/segmented";

/**
 * The one interactive leaf on the system surface. It exists so the segmented control can be
 * exercised for real rather than shown in a single frozen state: a control whose selection
 * cannot be moved is not verified, it is just drawn.
 */

const INCIDENT_OPTIONS = [
  { value: "event-stream-2018", label: "event-stream", detail: "78.6 d" },
  { value: "ua-parser-js-2021", label: "ua-parser-js", detail: "0.3 d" },
  { value: "node-ipc-2022", label: "node-ipc", detail: "9.5 d" },
  { value: "self-replicating-worm-2025", label: "worm 2025", detail: "0.5 d" },
  { value: "unavailable", label: "not ingested", disabled: true },
] as const;

type IncidentValue = (typeof INCIDENT_OPTIONS)[number]["value"];

export function SegmentedDemo() {
  const [selectedIncident, setSelectedIncident] = useState<IncidentValue>("event-stream-2018");

  return (
    <SegmentedControl
      label="Incident"
      options={INCIDENT_OPTIONS}
      value={selectedIncident}
      onChange={setSelectedIncident}
    />
  );
}
