<div align="center">

<img src="docs/readme/abi-logo.svg" alt="ABI User Behavior Analytics & Business Intelligence Platform Logo" title="ABI - Enterprise UBA & BI Platform" width="84" height="84" />

# ABI — Enterprise User Behavior Analytics (UBA) & Business Intelligence (BI) Platform

**An all-in-one, self-hosted analytics platform built for product growth, lifecycle operations, game publishing, and data teams**

Unifying **Cross-Platform Event Tracking · Real-Time Streaming ETL · High-Speed OLAP · 13 Behavioral & Growth Models · Self-Service SQL · Interactive BI Dashboards · Enterprise RBAC**

<p>
  <strong>🌐 Language / 语言 / 言語:</strong>
  <a href="README.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.en.md"><b>English</b></a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.vi.md">Tiếng Việt</a> ·
  <a href="README.th.md">ไทย</a> ·
  <a href="README.id.md">Bahasa Indonesia</a>
</p>

<p>
  <img src="https://img.shields.io/badge/Frontend-React_%7C_TypeScript_%7C_Tailwind_CSS-006BE6?style=flat-square&logo=react&logoColor=white" alt="React TypeScript Frontend" />
  <img src="https://img.shields.io/badge/Backend-Go_%7C_Gin_%7C_GORM-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go Backend" />
  <img src="https://img.shields.io/badge/Streaming-Apache_Flink_%7C_Kafka-E6526F?style=flat-square&logo=apacheflink&logoColor=white" alt="Flink Kafka Streaming" />
  <img src="https://img.shields.io/badge/OLAP-StarRocks-3B82F6?style=flat-square" alt="StarRocks OLAP" />
  <img src="https://img.shields.io/badge/Models-13_Analytics_Engines-6366F1?style=flat-square" alt="13 Behavioral Analytics Models" />
  <img src="https://img.shields.io/badge/SDKs-14%2B_Platforms-10B981?style=flat-square" alt="14+ Multi-Platform SDKs" />
  <a href="mailto:baidushanxivip@gmail.com"><img src="https://img.shields.io/badge/Commercial_Inquiry-baidushanxivip%40gmail.com-F59E0B?style=flat-square&logo=gmail&logoColor=white" alt="Contact baidushanxivip@gmail.com" /></a>
</p>

<p>
  <a href="#features">Core Features</a> •
  <a href="#models">13 Analytics Models</a> •
  <a href="#scenarios">Use Cases</a> •
  <a href="#screenshots">Screenshots</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#sdks">Multi-Platform SDKs</a> •
  <a href="#contact">Licensing & Contact</a>
</p>

<br />

<img src="docs/readme/signin-portal.png" alt="ABI Enterprise User Behavior Analytics & BI Platform Sign-In Portal" title="ABI Analytics Platform" width="100%" />

</div>

---

<a id="features"></a>

## ✨ Core Features

**ABI (AnyLink Behavioral Intelligence)** is an out-of-the-box, enterprise-grade **User Behavior Analytics (UBA)** and **Business Intelligence (BI)** platform. It connects the entire analytics lifecycle — from multi-platform event instrumentation and real-time stream processing to self-service exploration, SQL querying, customer segmentation, and collaborative BI dashboards — with full support for private cloud and on-premise deployment.

| Module | Capabilities |
| :--- | :--- |
| **📊 13 Self-Service Analytics Models** | Includes **Event Analysis** (multi-metric formulas, YoY/MoM, anomaly detection & quadrant views), **Funnel**, **Retention**, **User Path**, **Distribution**, **Interval**, and **User Property Analysis**, plus **Multi-Touch Attribution**, **LTV & ROI**, **User Lifecycle**, **PCU/ACU Concurrency**, **TopN Ranklist**, and **Self-Service SQL Sandbox**. |
| **🎯 Customer 360° & Segmentation** | Unifies anonymous device IDs and authenticated user accounts across platforms; provides **Customer 360° profiles & behavioral timelines**, **rule-based dynamic segments**, **offline batch imports**, **one-click segment saving from charts**, and **scheduled dynamic user tags**. |
| **🧩 All-Model Interactive BI Dashboards** | Multi-workspace folder organization, drag-and-drop grid layouts supporting **all 13 analytics models**, dashboard-wide time/filter synchronization, compact chart modes, and team sharing. |
| **🔌 Metadata & Tracking Governance** | Centralized multi-project, multi-timezone event dictionaries, property schemas, and business metrics; built-in **Live SDK Debug Playground** for payload validation, plus ingestion & error observability logs. |
| **🔐 Enterprise RBAC & Global UX** | Fine-grained user, role, and **Menu / Page / Button RBAC** permissions, strict project-level data isolation, and audit logs; native **13-language UI**, Light/Dark themes, and anti-leakage screen watermarks. |

---

<a id="models"></a>

## 🧠 13 Behavioral & Data Science Analytics Models

| Category | Models | Key Capabilities |
| :--- | :--- | :--- |
| **Core Behavior** | **Event / User Property Analysis** | Multi-metric formulas, period-over-period comparisons, multi-dimensional breakdowns, anomaly detection, and quadrant analysis |
| **Conversion & Retention** | **Funnel / Retention / Interval Analysis** | Multi-step conversion & drop-off diagnostics, cohort retention heatmaps & decay curves, conversion time-to-complete distributions |
| **Flow & Distribution** | **User Path / Distribution Analysis** | Forward & reverse multi-step Sankey flow diagrams, top journey rankings, and frequency/amount/duration bucket distributions |
| **Growth & Attribution** | **Attribution / TopN Ranklist Analysis** | First-touch, last-touch, linear, position-based (U-shaped), and time-decay attribution; real-time multi-metric TopN user leaderboards |
| **Monetization & Lifecycle** | **LTV & ROI / Lifecycle Analysis** | Cumulative cohort LTV growth curves, CAC payback lines & ROI milestones; New, Retained, Resurrected, and Churned user stage trends |
| **Real-Time & Ad-Hoc** | **Concurrency (PCU/ACU) / Self-Service SQL** | Peak Concurrent Users (PCU) & Average Concurrent Users (ACU) tracking; tenant-isolated read-only SQL sandbox with templates & instant charting |

---

<a id="scenarios"></a>

## 🌍 Typical Use Cases

- **Web, Mobile & Mini-Program Product Growth**: Measure feature adoption, diagnose onboarding & activation funnels, and optimize retention curves and user navigation paths.
- **E-Commerce & Digital Retail Operations**: Attribute conversions across ad channels and touchpoints, track CAC payback and LTV cohorts, and target high-value VIPs or churn-risk segments.
- **Game Development & Global Publishing**: Monitor real-time PCU/ACU concurrency, top-spender leaderboards, tutorial drop-offs, and cohort monetization across game engines and server SDKs.
- **Enterprise Private Data Platform**: Containerized delivery for air-gapped or private cloud environments requiring strict data sovereignty, multi-tenant isolation, and global multi-timezone collaboration.

---

<a id="screenshots"></a>

## 📸 Module Screenshots

### 1. Event Analysis Workbench & All-Model BI Dashboards

A zero-code exploration workspace for product managers, growth teams, and analysts: select metrics, filters, and dimensions on the left to render interactive charts and drill-down tables instantly, and pin any of the 13 models to live BI dashboards.

<img src="docs/readme/event-analysis.png" alt="ABI Event Analysis Workbench - Multi-Dimensional Trend Charts and Breakdown Tables" title="Event Analysis Workbench" width="100%" />

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/dashboard-workspace.png" alt="ABI BI Dashboard Workspace - All-Model Drag-and-Drop Grid and Global Filters" title="BI Dashboard Workspace" width="100%" />
      <p align="center"><b>BI Dashboard Workspace</b>: Multi-model drag-and-drop layout, workspace folders, and global time/filter sync</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/funnel-analysis.png" alt="ABI Funnel Analysis - Multi-Step Conversion Rates and Drop-Off Insights" title="Funnel Analysis" width="100%" />
      <p align="center"><b>Funnel Analysis</b>: Configurable conversion windows to pinpoint step-by-step conversion and drop-off</p>
    </td>
  </tr>
</table>

### 2. Cohort Retention & User Path Exploration

Dedicated visual models for tracking long-term engagement and discovering high-converting user journeys.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/retention-analysis.png" alt="ABI Cohort Retention Analysis - Decay Curves and Heatmap Matrix" title="Retention Analysis" width="100%" />
      <p align="center"><b>Retention Analysis</b>: Multi-period retention decay curves and daily/weekly/monthly cohort heatmaps</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/path-analysis.png" alt="ABI User Path Analysis - Multi-Step Sankey Diagram and Top Journeys" title="User Path Analysis" width="100%" />
      <p align="center"><b>User Path Analysis</b>: Forward and reverse Sankey flow diagrams with top-journey rankings</p>
    </td>
  </tr>
</table>

### 3. Attribution, LTV & ROI, Lifecycle, and TopN Ranklist

Quantify channel contribution, track CAC payback timelines, monitor user lifecycle transitions, and rank top contributors.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/attribution-analysis.png" alt="ABI Multi-Touch Attribution Analysis - Channel Conversion Contribution" title="Attribution Analysis" width="100%" />
      <p align="center"><b>Attribution Analysis</b>: First-touch, last-touch, linear, U-shaped, and decay models for channel ROI</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/ltv-analysis.png" alt="ABI LTV & ROI Analysis - Cohort Value Curves and CAC Payback Line" title="LTV & ROI Analysis" width="100%" />
      <p align="center"><b>LTV & ROI Analysis</b>: Cumulative cohort LTV curves, CAC breakeven line, and milestone tables</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/lifecycle-analysis.png" alt="ABI User Lifecycle Analysis - New, Retained, Resurrected, and Churned Users" title="Lifecycle Analysis" width="100%" />
      <p align="center"><b>Lifecycle Analysis</b>: Track New, Retained, Resurrected, and Churned user stage trends</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/ranklist-analysis.png" alt="ABI TopN Ranklist Analysis - Real-Time Multi-Metric User Leaderboard" title="Ranklist Analysis" width="100%" />
      <p align="center"><b>TopN Ranklist Analysis</b>: Real-time multi-metric rankings with direct user profile drill-down</p>
    </td>
  </tr>
</table>

### 4. Real-Time Concurrency (PCU/ACU) & Self-Service SQL Sandbox

Built for both live-ops concurrency monitoring and flexible ad-hoc SQL exploration inside a tenant-isolated sandbox.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/concurrency-analysis.png" alt="ABI Concurrency Analysis - Peak Concurrent Users (PCU) and Average Concurrent Users (ACU)" title="Concurrency Analysis" width="100%" />
      <p align="center"><b>Concurrency Analysis (PCU/ACU)</b>: Track Peak and Average Concurrent Users with peak-to-average ratios</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/sql-analysis.png" alt="ABI Self-Service SQL Workbench - Read-Only Sandbox and Instant Visualization" title="Self-Service SQL Analysis" width="100%" />
      <p align="center"><b>Self-Service SQL</b>: Tenant-isolated read-only SQL sandbox, preset templates, and instant charting</p>
    </td>
  </tr>
</table>

### 5. Customer 360° Profiles & Audience Segmentation

Drill down seamlessly from aggregate metrics to individual user timelines, and build reusable audience segments for cross-model comparison.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/user-profile-timeline.png" alt="ABI Customer 360 Profile and Behavioral Event Timeline" title="Customer 360 Profile" width="100%" />
      <p align="center"><b>Customer 360° & Timeline</b>: Unified identity graph, user properties, and chronological event stream</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/audience-segments.png" alt="ABI Audience Segmentation Builder - Rule Composer and Live Size Estimate" title="Audience Segments" width="100%" />
      <p align="center"><b>Audience Segments</b>: Rule-based user cohorts with real-time size preview and scheduled refresh</p>
    </td>
  </tr>
</table>

### 6. Metadata Governance, Live SDK Playground & RBAC Permissions

Maintain clean event schemas, validate tracking payloads in real time, and govern team access with granular RBAC controls.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/meta-events-governance.png" alt="ABI Metadata Event Dictionary and Tracking Governance" title="Metadata Governance" width="100%" />
      <p align="center"><b>Metadata Governance</b>: Manage display names, active status, and associated property schemas</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/sdk-live-playground.png" alt="ABI Live SDK Integration Guide and Payload Debugger" title="Live SDK Playground" width="100%" />
      <p align="center"><b>Live SDK Playground</b>: Interactive payload inspection and test-event validation</p>
    </td>
  </tr>
</table>

<details>
<summary><b>🔍 Click to expand: Enterprise RBAC Role & Menu/Button Permission Tree</b></summary>
<br />
<img src="docs/readme/rbac-permission-tree.png" alt="ABI Enterprise RBAC Role and Granular Permission Tree" title="RBAC Permission Management" width="100%" />
<p align="center"><b>RBAC Permission Management</b>: Visual tree-based authorization across modules, pages, and action buttons</p>
</details>

---

<a id="architecture"></a>

## 🏗️ Technical Architecture

ABI adopts a decoupled four-tier architecture — **High-Concurrency Ingest Gateway + Real-Time Stream Processing + Vectorized Columnar OLAP + Modern Decoupled Web Workbench** — delivering both high-throughput event ingestion and sub-second interactive queries.

### 1. Architecture Overview

```mermaid
flowchart TB
    subgraph Collect["1. Multi-Platform Data Collection"]
        Client["Client SDKs
Web / iOS / Android / Flutter / Mini-Programs / Game Engines"]
        Server["Server SDKs
Go / Java / Python / Node.js / C# / PHP / Ruby / C++ / Lua"]
        Import["Log Collectors & Batch Importers"]
    end

    subgraph Pipeline["2. Real-Time Ingest & Stream Processing"]
        Gateway["High-Concurrency Ingest Gateway (Go)"]
        MQ[("Apache Kafka
Streaming Message Buffer")]
        Stream["Apache Flink Streaming Engine
Cleansing · Schema Validation · Cross-Device ID Merge"]
    end

    subgraph DataStore["3. Storage & OLAP Engine"]
        OLAP[("StarRocks
Columnar OLAP for Events & User Profiles")]
        RDBMS[("MySQL
Metadata · Dashboards · RBAC & System Config")]
        Cache[("Redis
Session Store · Distributed Cache & Rate Limiting")]
    end

    subgraph Application["4. Analytics Service & Visual Workbench"]
        API["Admin & Analytics API (Go)
Query Compiler · Segment Scheduler · Project Isolation"]
        Web["ABI Web Workbench (React + TypeScript)
13 Analytics Models · BI Dashboards · Governance"]
    end

    Client & Server & Import -->|"Compressed Batch Ingest"| Gateway
    Gateway --> MQ
    MQ --> Stream
    Stream -->|"Real-Time Sink"| OLAP
    Stream <-->|"Metadata & Identity Sync"| RDBMS

    Web <-->|"RESTful API"| API
    API -->|"Sub-Second Vectorized Queries"| OLAP
    API <--> RDBMS
    API <--> Cache
```

### 2. Layer Responsibilities

- **Data Collection Layer**: Cross-platform SDKs for web, mobile, game engines, and backend servers, plus log watchers and batch importers with local buffering and compressed batching.
- **Ingest & Stream Processing Layer**: A dedicated Go ingest gateway handles authentication and traffic spikes, buffered by Kafka; Apache Flink performs real-time data cleansing, dynamic schema validation, GeoIP enrichment, and cross-device identity resolution.
- **Storage & OLAP Layer**: StarRocks columnar vectorized storage powers sub-second event, funnel, retention, attribution, LTV, and cohort queries; MySQL stores metadata, dashboard layouts, and RBAC rules; Redis handles caching and rate limiting.
- **Analytics & Presentation Layer**: The Go backend compiles visual query builders and read-only SQL sandboxes into tenant-isolated OLAP queries, while the React + TypeScript + ECharts frontend provides an intuitive workbench and drag-and-drop BI experience.

### 3. Tech Stack Summary

| Layer | Technologies | Responsibilities |
| :--- | :--- | :--- |
| **Frontend Workbench** | React · TypeScript · Vite · Tailwind CSS · ECharts | 13 self-service analytics models, visualizations, drag-and-drop dashboards, 13-language UI |
| **Backend Services** | Go · Gin · GORM | Admin API, multi-model SQL query compiler, segment scheduling, high-throughput ingest gateway |
| **Stream Processing** | Java · Apache Flink · Apache Kafka | Real-time ETL, dynamic metadata sync, identity resolution, raw event archival |
| **Storage & OLAP** | StarRocks · MySQL · Redis | Real-time columnar OLAP analytics, relational metadata/config store, distributed cache |
| **Deployment** | Docker · Docker Compose · Nginx | Single-node containerized quickstart and horizontally scalable private-cloud clusters |

---

<a id="sdks"></a>

## 📦 Multi-Platform Data Collection Ecosystem

Comprehensive cross-platform SDKs with documentation in 13 languages and interactive examples — see **[SDK Documentation & Source Directory](abi.sdk/README.en.md)**:

- **Web & Cross-Platform**: JavaScript / TypeScript Web SDK, App H5 WebView Bridge, WeChat Mini-Program, React Native
- **Native Mobile**: iOS (Swift), Android (Kotlin), Flutter (Dart)
- **Game Engines**: Unity (C#), Unreal Engine / Cocos2d-x (C/C++), Cocos Creator / Egret / LayaAir, Cocos2d-Lua
- **Backend Languages**: Go, Java, Python, Node.js, C# (.NET), PHP, Ruby, Lua
- **Universal API & Import Tools**: Standard HTTP RESTful batch ingestion API, real-time log file tailer, and log collector templates

---

<a id="contact"></a>

## 📬 Commercial Licensing & Inquiries

ABI is available for **enterprise commercial licensing, full source-code delivery, private deployment, and custom development**.  
To request a live demo, pricing details, or commercial licensing, please contact us via email:

- **Sales & Licensing Email**: **[baidushanxivip@gmail.com](mailto:baidushanxivip@gmail.com)**

---

<div align="center">

**[简体中文](README.md)** · **[繁體中文](README.zh-TW.md)** · **[English](README.en.md)** · **[日本語](README.ja.md)** · **[한국어](README.ko.md)** · **[Español](README.es.md)** · **[Português](README.pt.md)** · **[Deutsch](README.de.md)** · **[Français](README.fr.md)** · **[Русский](README.ru.md)** · **[Tiếng Việt](README.vi.md)** · **[ไทย](README.th.md)** · **[Bahasa Indonesia](README.id.md)**

<sub>Keywords: User Behavior Analytics (UBA), Product Analytics, Business Intelligence (BI), Event Tracking, Funnel Analysis, Cohort Retention, Multi-Touch Attribution, LTV & ROI, Lifecycle Analysis, PCU/ACU Concurrency, Self-Service SQL, User Path Sankey, Customer 360, Audience Segmentation, StarRocks OLAP, Apache Flink, Self-Hosted Analytics Platform</sub>

</div>
