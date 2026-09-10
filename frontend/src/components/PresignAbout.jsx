import React from "react";
import {
  Container,
  Header,
  Table,
  SpaceBetween,
  Box,
  Badge,
} from "@cloudscape-design/components";
import {
  intro,
  tools,
  features,
  differentiators,
  caveats,
  legend,
} from "../data/comparison.mjs";

// Renders a legend value ("yes" | "no" | "partial") as a colored badge/glyph.
function Mark({ value }) {
  if (value === "yes") {
    return <span style={{ color: "#037f0c", fontWeight: 700 }} title="Full support">{legend.yes}</span>;
  }
  if (value === "partial") {
    return <span style={{ color: "#8d6605", fontWeight: 700 }} title="Partial / indirect">{legend.partial}</span>;
  }
  return <span style={{ color: "#d91515", fontWeight: 700 }} title="Not supported">{legend.no}</span>;
}

export default function PresignAbout() {
  // Build one Cloudscape Table column per tool, plus a leading "Capability" column.
  const columnDefinitions = [
    {
      id: "capability",
      header: "Capability",
      cell: (row) => <strong>{row.label}</strong>,
      minWidth: 240,
    },
    ...tools.map((t) => ({
      id: t.key,
      header: t.self ? (
        <span>
          {t.name} <Badge color="green">this tool</Badge>
        </span>
      ) : (
        t.name
      ),
      cell: (row) => <Mark value={row.values[t.key]} />,
      minWidth: 90,
    })),
  ];

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header variant="h1" description="Presign URLs. Invoke APIs. Bridge IAM & SSO roles.">
            About SignBridge
          </Header>
        }
      >
        <SpaceBetween size="l">
          {/* The product hero. Served from frontend/public (so the path carries
              Vite's /signbridge/ base) as a 220 KB JPEG rather than the 2 MB
              source PNG in assets/, since this page is in the app bundle's
              critical path for anyone who opens it. */}
          <img
            src={`${import.meta.env.BASE_URL}signbridge-hero.jpg`}
            alt="A signing key lit inside the tower of the Golden Gate Bridge, with request traffic streaming across the deck"
            style={{
              display: "block",
              width: "100%",
              maxWidth: 820,
              height: "auto",
              margin: "0 auto",
              borderRadius: 12,
            }}
          />
          <section>
            <h2>SignBridge</h2>
            <p>
              SignBridge is a self-hosted tool for generating presigned AWS URLs,
              invoking AWS and REST APIs, browsing S3, running code against your
              profiles, and managing request history, favorites, and templates. The{" "}
              <strong>SignBridge</strong> engine handles SigV4 signing, credential
              resolution, and token refresh across every profile type.
            </p>
          </section>
          <section>
            <h3>Key capabilities</h3>
            <ul>
              <li>Presign URLs for AWS services beyond S3 (EC2, SSM, and more)</li>
              <li>
                Sign as any of four AWS identities: IAM keys, IAM Identity Center
                (SSO), an EC2 instance&apos;s own role (over SSH and IMDSv2), or an
                EKS IRSA service-account role (no kubectl required)
              </li>
              <li>REST API Basic Auth and Bearer Token profiles for non-AWS endpoints</li>
              <li>AWS CLI invocation mode, using the selected profile&apos;s credentials</li>
              <li>
                Sandbox mode: write Python, JavaScript, TypeScript, or Java in the
                browser and run it against a profile in a throwaway container
              </li>
              <li>
                S3 World: browse buckets and view object contents in place — parquet
                as a table, spreadsheets as sheets, gzipped logs as text — with a
                recursive, match-anywhere search
              </li>
              <li>History, favorites, labels, and Postman-style template collections</li>
              <li>AI chat copilot for natural-language presign and invoke (optional)</li>
              <li>MCP server for Cursor and other AI tool integrations</li>
            </ul>
          </section>
        </SpaceBetween>
      </Container>

      <Container
        header={
          <Header variant="h2" description="How SignBridge stacks up against the closest alternatives">
            How SignBridge compares
          </Header>
        }
      >
        <SpaceBetween size="l">
          <p>{intro}</p>

          <Table
            variant="embedded"
            columnDefinitions={columnDefinitions}
            items={features}
            wrapLines
            stripedRows
            ariaLabels={{ tableLabel: "Feature comparison" }}
          />

          <Box fontSize="body-s" color="text-body-secondary">
            Legend: {legend.yes} full · {legend.partial} partial / indirect ·{" "}
            {legend.no} not supported.
          </Box>

          <section>
            <h3>Where SignBridge stands out</h3>
            <SpaceBetween size="s">
              {differentiators.map((d) => (
                <div key={d.title}>
                  <strong>{d.title}.</strong> {d.body}
                </div>
              ))}
            </SpaceBetween>
          </section>

          <section>
            <h3>Honest caveats</h3>
            <ul>
              {caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </section>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
