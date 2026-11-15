# ABI Unity Game Engine Client SDK Guide & Examples (`Abi.GameEngines.Unity`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`AbiUnityAnalytics` is the official **Unity Client C# Data Collection SDK** for the ABI User Behavior Analytics (UBA) & BI Platform (semantically aligned with ThinkingData Unity Client SDK v3.4), designed for mobile (iOS/Android), PC (Steam/Windows/macOS), console, and mini-game targets built with Unity.

---

## 1. Key Features

- **ThinkingData Dual-Identity Persistence (`distinct_id` + `login_id`)**:
  - Automatically generates a UUIDv4 visitor/device `distinct_id` (≤ 64 UTF-8 bytes) on first launch and persists it via `PlayerPrefs` (`abi_unity_sdk_distinct_id`); supports custom visitor IDs via `Identify(distinctId)` (local state update only, zero network events).
  - Calling `Login(accountId)` (≤ 128 UTF-8 bytes) locally persists `login_id` **without overwriting `distinct_id` and without sending any network event**; subsequent events carry both `distinct_id` and `login_id` so Flink Job1 links pre-login visitor actions with post-login account events in StarRocks `identity_map`.
  - Calling `Logout()` clears `login_id` locally while keeping `distinct_id` intact (zero network events).
- **Two-Step Preview & Confirm Submit Workflow (`autoFlush = false`)**:
  - When initialized with `Initialize(..., autoFlush: false)`, tracked events stay staged in memory without automatic network requests.
  - **Step 1 (Preview Single Request JSON)**: Call `BuildPendingBatchJson(indented: true)` to inspect the single pretty-printed `POST /collect/api/v1/track/batch` request JSON in place.
  - **Step 2 (Confirm & Submit)**: Click the "Confirm Submit" UI button or call `Flush(callback)` to send the batch and inspect the gateway response.
- **Game-Specific Capabilities**:
  - **High-Precision Stage / Boss Timer (`TimeEvent`)**: Call `TimeEvent("BossDefeated")` when a battle starts; the next `Track("BossDefeated")` call automatically computes and attaches `$duration` in seconds (rounded to milliseconds).
  - **64-Bit Snowflake ID Precision Protection (`> 2^53 - 1`)**: Automatically converts `long` / `ulong` values exceeding `9007199254740991` (such as Snowflake battle IDs, item UIDs, or order numbers) into decimal strings.
  - **Static & Dynamic Super Properties**: Register static properties (`SetSuperProperties`, e.g., `channel`, `server_zone`) and real-time dynamic callbacks (`SetDynamicSuperProperties`, e.g., current scene, live FPS).
  - **All 7 `$user_*` Player Profile Operations with Isolation**: Provides `UserSet`, `UserSetOnce`, `UserAdd`, `UserUnset`, `UserAppend`, `UserUniqAppend`, and `UserDelete`, automatically excluding super properties and device preset properties so environment metadata never pollutes `dim_users`.

---

## 2. Files & Installation

| File | Description |
| :--- | :--- |
| [`AbiUnityAnalytics.cs`](AbiUnityAnalytics.cs) | Core Unity C# Client SDK (zero external plugins, compatible with Mono & IL2CPP) |
| [`AbiUnityDemoMonoBehaviour.cs`](AbiUnityDemoMonoBehaviour.cs) | Two-step interactive demo script (`AbiUnityDemoMonoBehaviour` component & `AbiUnityDemoRunner`) |

Copy [`AbiUnityAnalytics.cs`](AbiUnityAnalytics.cs) (and optionally [`AbiUnityDemoMonoBehaviour.cs`](AbiUnityDemoMonoBehaviour.cs)) into your Unity project's `Assets/Scripts/AbiSdk/` folder. No third-party DLLs or NuGet packages are required.

---

## 3. Two-Step Interactive Demo (1. Preview Single Request JSON → 2. Confirm Submit)

```csharp
using Abi.GameEngines.Unity;
using UnityEngine;

public class GameBootstrap : MonoBehaviour
{
    void Start()
    {
        // Step 1: Configure gameplay parameters and preview the single POST /collect/api/v1/track/batch request JSON
        string previewJson = AbiUnityDemoRunner.PreviewScenarioJson(
            serverUrl: "http://127.0.0.1:8081",
            projectId: 1,
            projectToken: "abi_tok_unity_demo"
        );
        Debug.Log("=== Pending Request JSON Preview ===\n" + previewJson);

        // Step 2: Confirm and submit the staged batch to the ABI gateway
        AbiUnityDemoRunner.ConfirmSubmit((statusCode, responseJson) =>
        {
            Debug.Log($"=== Gateway Response (HTTP {statusCode}) ===\n{responseJson}");
        });
    }
}
```

---

## 4. Client Integration Guide: Required Fields, Auto-Collected Fields & Gateway IP Extraction

Because the Unity Client SDK runs directly on the player's device, its field responsibilities differ significantly from backend Server SDKs:

| Field / Concept | Unity Client Responsibility | How It Works End-to-End |
| :--- | :--- | :--- |
| **`projectId` & `projectToken`** | **[Required at `Initialize`]** | Passed once when initializing `AbiUnityAnalytics.Shared.Initialize(...)` at game startup. |
| **`eventName`** | **[Required per `Track`]** | Custom event names must match `^[A-Za-z_][A-Za-z0-9_]*$` (≤ 128 chars). Profile system events (`$user_*`) are filled automatically by `User*()` methods. |
| **Player Identity (`distinct_id` / `login_id`)** | **[Auto-Managed by SDK]** | The SDK automatically generates and persists visitor `distinct_id` in `PlayerPrefs`. You do **not** pass identity IDs on every `Track` call—simply call `Login(accountId)` when the player logs in (pure local state update) and `Logout()` on sign-out. |
| **Device Preset Properties (`$os`, `$device_model`, `$screen_width`, etc.)** | **[Auto-Collected by SDK]** | Extracted automatically from `UnityEngine.SystemInfo`, `Screen`, and `Application` for behavior events, and automatically excluded from `$user_*` profile events. |
| **Player Public IP & GeoIP (`#ip` / `$ip`)** | **[Do NOT Pass from Client; Extracted Automatically by Gateway]** | Client devices sit behind home Wi-Fi or cellular NAT and only see local LAN IPs. **Do not pass `#ip` from Unity**—the ABI Ingest Gateway (`:8081`) automatically extracts the player's real public IP from the HTTP connection / `X-Forwarded-For` header so Flink Job1 resolves Country, Province, and City. |
| **Event Time (`timestamp` / `#time`)** | **[Auto-Generated]** | Defaults to current UTC milliseconds (`DateTimeOffset.UtcNow`). Pass `properties["#time"]` or `timestamp` only when backfilling offline events. |
| **Idempotent `event_id`** | **[Auto-Generated]** | Defaults to UUIDv4 and is preserved across network retries. For deterministic deduplication, pass an explicit `eventId` directly to `Track` (Note: `TrackFirst`, `TrackUpdate`, and `TrackOverwrite` are unsupported in the current version per RESTFUL_API.md §3.3 D7① / G6 gate). |

> **Client + Game Server Payment Attribution Tip**: When in-app purchase callbacks are verified and reported by your backend server (using the C#/Go/Java Server SDK), forward `AbiUnityAnalytics.Shared.DistinctId` from the Unity client to your game server (e.g., via header `X-ABI-Distinct-Id`) when creating the order, so the backend can pass both `accountId` (`login_id`), `distinctId` (`distinct_id`), and the player's `#ip`.
