# ABI 다국어 데이터 수집 SDK 스위트 (`abi.sdk`)

**언어 / Language / 言語**: [简体中文](README.md) | [繁體中文](README.zh-TW.md) | [English](README.en.md) | [日本語](README.ja.md) | **[한국어](README.ko.md)** | [Español](README.es.md) | [Português](README.pt.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md)

`abi.sdk`는 ABI 사용자 행동 분석(UBA) 및 비즈니스 인텔리전스(BI) 플랫폼을 위한 프로덕션 환경 수준의 클라이언트 및 서버 데이터 수집 SDK를 제공합니다. 스위트의 전체 설계는 [ThinkingData(数数科技) SDK v3.4 규격](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html)을 벤치마킹하여, 필드 프로토콜 규약, 사용자 식별자 매핑 및 데이터 유효성 검증 레벨에서 백엔드 수집 게이트웨이 [`abi.srv`](../abi.srv/)(`:8081`) 및 스트리밍/배치 통합 처리 엔진 [`abi.flink`](../abi.flink/)(Job1 실시간 ETL 및 Job2 원시 ODS 적재)과 완벽하게 정렬되어 있습니다.

---

## 1. 디렉터리 구조, 다국어 문서 색인 및 플랫폼 지원 매트릭스

| 디렉터리 | 대상 플랫폼 / 패키지 | 다국어 README (한 / 중 / 영 / 일) | 핵심 기능 및 지원 범위 | 검증 명령어 |
|------|-------------------|-------------------------------|--------------|----------|
| [`RESTFUL_API.md`](RESTFUL_API.md) | 크로스 언어 네이티브 HTTP RESTful API | [한국어](RESTFUL_API.md) | SDK 의존성 없는 네이티브 HTTP 게이트웨이 직결 가이드: API 프로토콜 사양, 포맷팅된 JSON `curl` 예제(단건/배치 전송, 듀얼 ID 자동 기여도 연결, 당일 재시도 멱등성 중복 제거, 7종 `$user_*` 프로필, Gzip 압축, `debug` 및 `dry_run` 사전 검증) 및 Python / Node.js 네이티브 호출 예제 포함 | 문서 내 `curl` `dry_run: true` 온라인 테스트 명령어 참조 |
| [`spec/test-vectors/`](spec/test-vectors/) | 크로스 언어 골든 테스트 벡터 규약 | — | 크로스 언어 공유 표준 JSON 테스트 벡터. 식별자 정규화(64/128 바이트 UTF-8 경계, 유니코드 공백 제거, 제어 문자 차단), 이벤트 및 속성 명명 규칙 검증, 64비트 대용량 정수(`> 2^53 - 1`) 정밀도 보호 및 `$user_*` 사용자 프로필 조작 규약 포함 | 각 언어별 SDK 단위 테스트 스위트에서 공통 로드하여 검증 |
| [`ts-web/`](ts-web/) | Web / H5 / TypeScript(`@anylink/abi-web-sdk`), App-H5 연동 브릿지, 미니프로그램/RN 및 H5 게임 엔진(Cocos Creator / Egret / LayaAir / Weex) 어댑터 | [중문](ts-web/README.md) · [EN](ts-web/README.en.md) · [JA](ts-web/README.ja.md)<br/>예제: [중문](ts-web/examples/README.md) · [EN](ts-web/examples/README.en.md) · [JA](ts-web/examples/README.ja.md) | `init`, `identify`, `login`, `logout`, `track`, `timeEvent`, `setSuperProperties`, `setDynamicSuperProperties`, 전체 `$user_*` 프로필 갱신, SPA 라우팅 `$pageview` 및 `$AppEnd` 자동 수집, App-H5 WebView 브릿지(`createH5AppBridgeAdapter`), H5 게임 엔진 어댑터(`createCocosCreatorAdapter` / `createEgretAdapter` / `createLayaAirAdapter` / `createWeexAdapter`), 페이지 이탈 시 `sendBeacon` 전송 지원(*참고: D7① / G6 게이트 제약에 따라 `trackFirst`/`trackUpdate`/`trackOverwrite`는 현재 버전에서 미지원으로 표준화 표기*) | `cd abi.sdk/ts-web && pnpm test` |
| [`go/`](go/) | Go 서버 SDK(`abi.sdk/go`) | [중문](go/README.md) · [EN](go/README.en.md) · [JA](go/README.ja.md)<br/>데모: [중문](go/examples/demo/README.md) · [EN](go/examples/demo/README.en.md) · [JA](go/examples/demo/README.ja.md) | 동시성 안전(Concurrency-safe) `AbiAnalytics` 클라이언트. 4가지 컨슈머 내장: `StagingConsumer`(요청 JSON 2단계 미리보기 및 확인 전송), `BatchConsumer`(비동기 버퍼링 배치 HTTP + Gzip 압축 + 지수 백오프 재시도), `LoggerConsumer`(일별/시간별/파일 크기별 로컬 JSONL 롤링 로깅), `DebugConsumer`(동기식 L4 유효성 검증 및 `dry_run` 시뮬레이션) | `cd abi.sdk/go && go test -race ./...` |
| [`java/`](java/) | Java 11+ 서버 SDK(`com.anylink.abi:abi-java-sdk`) | [중문](java/README.md) · [EN](java/README.en.md) · [JA](java/README.ja.md) | 스레드 안전(Thread-safe) `AbiAnalytics`(`AutoCloseable` 정상 종료 구현). `StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, `DebugConsumer` 제공, IEEE-754 배정밀도 부동소수점 한계(`> 2^53 - 1`)를 초과하는 Long 정수 속성을 문자열로 자동 무손실 직렬화 | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test` |
| [`python/`](python/) | Python 3 서버 SDK(`abi.sdk/python`) | [중문](python/README.md) · [EN](python/README.en.md) · [JA](python/README.ja.md) | 외부 서드파티 라이브러리 의존성 없는 순수 Python 3 표준 라이브러리 구현. `StagingConsumer`, `BatchConsumer`(백그라운드 데몬 스레드 + Gzip + 지수 백오프 재시도), `LoggerConsumer`, `DebugConsumer` 제공, `bool` 및 `> 2^53 - 1` 임의 정밀도 대형 정수 문자열 변환 자동 식별, `#time` / `$time` 추출 및 `#ip` / `$ip` 포워딩 지원 | `python3 -m unittest discover -s abi.sdk/python/tests -v` |
| [`nodejs/`](nodejs/) | Node.js 서버 SDK(`@anylink/abi-node-sdk`) | [중문](nodejs/README.md) · [EN](nodejs/README.en.md) · [JA](nodejs/README.ja.md) | 외부 의존성 없는 ESM + TypeScript 타입 선언(`index.d.ts`). Express / Fastify / Koa / NestJS 다중 사용자 무상태 동시 전송 지원, `StagingConsumer`, `BatchConsumer`(`zlib.gzipSync`), `LoggerConsumer`, `DebugConsumer` 내장, `BigInt` 및 안전하지 않은 정수 자동 문자열 변환 지원 | `node --test abi.sdk/nodejs/test/abi-node-sdk.test.mjs` |
| [`csharp/`](csharp/) | C# / .NET 서버 SDK(`Anylink.Abi.Sdk`) | [중문](csharp/README.md) · [EN](csharp/README.en.md) · [JA](csharp/README.ja.md) | .NET 표준 라이브러리(`System.Text.Json` / `HttpClient` / `GZipStream`) 기반 스레드 안전 서버 SDK. `StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, `DebugConsumer` 및 전체 `Track*` / `User*` 메서드 제공 | `dotnet run --project abi.sdk/csharp -- --test` |
| [`php/`](php/) | PHP 8.1+ 서버 SDK(`Anylink\Abi\Sdk`) | [중문](php/README.md) · [EN](php/README.en.md) · [JA](php/README.ja.md) | 외부 의존성 없는 PHP 8.1+ 서버 SDK(Laravel / Symfony / PHP-FPM / Swoole 완벽 호환). `StagingConsumer`, `BatchConsumer`(`gzencode` + 재시도), `LoggerConsumer`, `DebugConsumer` 내장 및 골든 테스트 벡터 전체 검증 | `php abi.sdk/php/tests/abi_sdk_test.php` |
| [`ruby/`](ruby/) | Ruby 서버 SDK(`AbiSdk`) | [중문](ruby/README.md) · [EN](ruby/README.en.md) · [JA](ruby/README.ja.md) | 외부 Gem 의존성 없는 Ruby 표준 라이브러리 구현(Rails / Sidekiq / Rack 호환, `snake_case` 및 `camelCase` 메서드명 동시 지원). `StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, `DebugConsumer` 제공 | `ruby abi.sdk/ruby/test/abi_sdk_test.rb` |
| [`cpp/`](cpp/) | C / C++17 크로스 플랫폼 SDK(서버 및 Unreal Engine / Cocos2d-x 클라이언트) | [중문](cpp/README.md) · [EN](cpp/README.en.md) · [JA](cpp/README.ja.md) | 외부 의존성 없는 싱글 헤더 C++17 SDK([`include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)) 및 DLL 간 STL ABI 충돌을 방지하는 `extern "C"` 순수 C 인터페이스 제공. C++ 게임 서버/백엔드 무상태 모드 및 Unreal Engine / Cocos2d-x 클라이언트 디바이스 세션 모드(`time_event` 스톱워치 소요 시간 측정 포함) 동시 지원 | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && /tmp/abi_cpp_test` |
| [`lua/`](lua/) | Lua 5.3+ 크로스 플랫폼 SDK(OpenResty / Skynet 서버 및 Cocos2d-Lua 클라이언트) | [중문](lua/README.md) · [EN](lua/README.en.md) · [JA](lua/README.ja.md) | 순수 Lua 5.3+ 표준 라이브러리 기반 무의존성 단일 파일 [`abi_sdk.lua`](lua/abi_sdk.lua). 결정론적 JSON 인코더/디코더 및 UTF-8 유효성 검사기 내장, 게임 서버/게이트웨이 무상태 모드 및 클라이언트 상태 유지 모드 동시 지원 | `lua abi.sdk/lua/tests/test_abi_sdk.lua` |
| [`mobile/`](mobile/) | 모바일 클라이언트 SDK(Flutter Dart, Android Kotlin, iOS Swift) | 총괄: [중문](mobile/README.md) · [EN](mobile/README.en.md) · [JA](mobile/README.ja.md)<br/>Flutter: [중문](mobile/flutter/README.md) · [EN](mobile/flutter/README.en.md) · [JA](mobile/flutter/README.ja.md)<br/>Android: [중문](mobile/android/README.md) · [EN](mobile/android/README.en.md) · [JA](mobile/android/README.ja.md)<br/>iOS: [중문](mobile/ios/README.md) · [EN](mobile/ios/README.en.md) · [JA](mobile/ios/README.ja.md) | 네이티브 스레드 안전 큐 및 주기적 배치 플러시, 듀얼 ID 식별자 바인딩(`identify` / `login` / `logout`), 고정밀 스톱워치 이벤트 타이머(`timeEvent` -> `$duration`), 당일 고정 `event_id` 멱등성 전송(D7① / G6 게이트 제약에 따라 `trackFirst`/`trackUpdate`/`trackOverwrite` 미지원 표기), 전체 `$user_*` 프로필 변이 및 2단계 미리보기 확인 인터랙티브 데모 제공 | `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| [`game-engines/unity/`](game-engines/unity/) | Unity 게임 엔진 클라이언트 SDK(C# `AbiUnityAnalytics`) | [중문](game-engines/unity/README.md) · [EN](game-engines/unity/README.en.md) · [JA](game-engines/unity/README.ja.md) | Unity 게임 클라이언트를 위해 특화 설계된 디바이스 세션 관리, 고정밀 타이머, 오프라인 큐 및 2단계 미리보기 확인 컴포넌트(`AbiUnityDemoMonoBehaviour`) | `dotnet run --project abi.sdk/csharp -- --test` |
| [`data-import/`](data-import/) | 데이터 전송 및 오프라인 적재 도구 스위트(LogBus 2 / Filebeat / Logstash / Vector / DataX) | [중문](data-import/README.md) · [EN](data-import/README.en.md) · [JA](data-import/README.ja.md) | 数数 LogBus 2 규격의 실시간 로그 수집 데몬 프로세스([`abi_logbus.py`](data-import/abi_logbus.py), 각 언어 `LoggerConsumer`가 기록한 `.jsonl` 파일 감시, 체크포인트 이어받기 및 Gzip 배치 전송 지원), Filebeat, Logstash, Vector, Alibaba DataX 템플릿 기본 제공 | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |

---

## 2. 수집 게이트웨이 배치 전송 프로토콜 규약 (`POST /collect/api/v1/track/batch`)

모든 클라이언트 및 서버 HTTP Consumer는 수집 게이트웨이로 표준화된 JSON 배치 페이로드를 동일하게 전송합니다:

```json
{
  "project_id": 1,
  "project_token": "abi_tok_...",
  "debug": false,
  "dry_run": false,
  "events": [
    {
      "event_id": "018f6b9c-7c40-7000-8000-000000000001",
      "event_name": "OrderPaid",
      "distinct_id": "vis_device_001",
      "login_id": "user_10001",
      "timestamp": 1731174000000,
      "properties": {
        "$lib": "abi-ios-sdk",
        "$lib_version": "1.0.0",
        "$os": "iOS",
        "$app_version": "2.1.0",
        "$duration": 12.345,
        "amount": 199.0,
        "order_id": "9007199254740993"
      }
    }
  ]
}
```

### 2.1 듀얼 ID 및 멱등성 식별자 규약 (ThinkingData 규격 준수)

- **`distinct_id` (방문자 / 디바이스 ID)**: 프로토콜 레이어의 고유한 방문자 또는 단말 디바이스 식별자입니다. ASCII 제어 문자(`0x00–0x08`, `0x0E–0x1F`, `0x7F`)의 포함이 엄격히 금지되며, 앞뒤 유니코드 공백 문자는 자동으로 제거됩니다. UTF-8 바이트 길이 상한은 **64바이트**입니다. 클라이언트 SDK 초기화 시 로컬 방문자 ID가 자동으로 생성 및 영구 저장되며, `identify(visitorId)`를 통해 커스텀 지정할 수도 있습니다. 서버 환경의 순수 계정 시나리오(유효한 `login_id`가 존재하고 클라이언트 디바이스 컨텍스트가 없는 경우)에서는 빈 문자열 `""`을 전달할 수 있습니다(**`login_id`를 `distinct_id`로 복사하거나 잘라내어 역채우기하는 것은 엄격히 금지됩니다**).
- **`login_id` (실명 로그인 계정 ID)**: 사용자가 인증 또는 계정 로그인을 완료한 후의 비즈니스 계정 식별자이며, UTF-8 바이트 길이 상한은 **128바이트**입니다(미로그인 방문자는 생략하거나 `""` 전달 가능). 각 이벤트는 `distinct_id`와 `login_id` 중 **최소 하나 이상이 반드시 비어 있지 않아야 합니다**.
- **클라이언트 `login()` 순수 로컬 상태 관리 및 엔드투엔드 자동 ID-Mapping**: 클라이언트가 `login(accountId)`를 호출하면 **로컬 스토리지에만 `login_id`를 영구 저장**합니다(기존 `distinct_id`는 그대로 유지되며, 별도의 ID 바인딩 이벤트는 자동 발송되지 않음). `logout()` 호출 시 로컬 `login_id`만 초기화하고 현재 `distinct_id`는 계속 유지합니다. 클라이언트와 서버를 불문하고, **임의의 행동 이벤트(`Track*`) 또는 사용자 프로필 이벤트(`$user_*`)에 비어 있지 않은 `distinct_id`와 `login_id`가 동시에 포함되는 즉시**, 다운스트림 Flink Job1이 이를 실시간으로 `abi.identity_map`에 기록하여 라이프사이클 전반에 걸친 기여도 분석 연결을 완성합니다.
- **`event_id` (이벤트 멱등성 기본키)**: UTF-8 바이트 길이 상한은 **64바이트**입니다. 클라이언트 네트워크 끊김, HTTP `429` 속도 제한 또는 `5xx` 서버 일시 오류로 인한 재시도 발생 시, 큐는 원본 `event_id`를 그대로 유지하여 멱등성 적재를 보장합니다.(*참고: 현재 버전은 D7① / G6 게이트 제약에 따라 `trackFirst` 최초 중복 제거 및 `trackUpdate`/`trackOverwrite` 일자 간 업데이트가 미지원으로 통일 표기되어 있으며, 멱등성이 필요한 경우 동일 이벤트 일자 파티션 내에서 표준 `track`에 고정 `event_id`를 포함하여 전송하십시오*).

### 2.2 64비트 대형 정수($> 2^{53}-1$) 정밀도 보호

JavaScript 및 일반 JSON 파서는 IEEE-754 배정밀도 부동소수점 규격을 따르므로, 최대 안전 정수는 $2^{53}-1$ (즉, `9007199254740991`)입니다.

- 정수 속성값의 절댓값이 `9007199254740991`을 초과하는 경우(예: 분산 스노우플레이크 알고리즘으로 생성된 64비트 주문 번호 `9007199254740993` 또는 경계값 `Int64.min` / `Long.MIN_VALUE`), 각 언어별 SDK는 직렬화 전 이를 10진수 문자열(`"9007199254740993"`)로 자동 변환하여 크로스 플랫폼 전송 과정에서 하위 비트 정밀도가 손실되는 현상을 완벽히 차단합니다.
- 또한 모든 SDK는 큐 삽입 전 `NaN`, `Infinity` / `-Infinity` 등 유한하지 않은 부동소수점 값과 `null` 또는 중첩 객체/배열이 포함된 비정상 리스트 요소를 사전에 차단합니다.

### 2.3 `$user_*` 사용자 프로필 이벤트 규약

SDK는 7가지 표준 사용자 프로필 변경 인터페이스를 제공하며, 내부적으로 시스템 예약 이벤트로 인코딩되어 StarRocks 사용자 차원 테이블(`dim_users`)로 라우팅됩니다:

| SDK 메서드 | 프로토콜 `event_name` | 프로필 업데이트 의미 |
|----------|-------------------|--------------|
| `userSet(props)` | `$user_set` | 사용자 프로필 속성 덮어쓰기(존재하면 덮어쓰고, 없으면 새로 추가) |
| `userSetOnce(props)` | `$user_set_once` | 대상 프로필 속성이 설정되지 않은 경우에만 최초 기록(최초 설치 채널, 가입 경로 등 불변 기여도 속성에 적합) |
| `userAdd(props)` | `$user_add` | 숫자형 프로필 속성의 원자적 가산/감산 수행(포인트 변동, 누적 결제 금액 등) |
| `userUnset(keys)` | `$user_unset` | 지정된 사용자 프로필 속성 키 초기화(페이로드 내 속성값은 삭제 플레이스홀더로 `0` 자동 입력) |
| `userAppend(props)` | `$user_append` | 리스트(Array) 타입 프로필 속성 끝에 요소 추가(중복 허용) |
| `userUniqAppend(props)` | `$user_uniq_append` | 리스트(Array) 타입 프로필 속성에 요소를 추가하며 자동 중복 제거(관심 태그, 획득 뱃지 컬렉션 등에 적합) |
| `userDelete()` | `$user_del` | 현재 사용자의 프로필 레코드 삭제 마킹 |

> **격리 제약**: SDK는 `$user_*`(및 호환 접두사 `#user_*`) 이벤트의 `properties`를 조립할 때 정적/동적 공통 속성(Super Properties) 및 `$os`, `$app_version`, `$lib` 등 클라이언트 환경 사전 정의 속성을 **주입하지 않으며**, 이를 통해 환경 메타데이터가 사용자 프로필 와이드 테이블을 오염시키는 것을 방지합니다.

### 2.4 엔지니어 관점: 각 SDK 환경별 필드 필수 여부 및 책임 경계 비교 (중요)

실제 엔지니어링 구현 시, **클라이언트 SDK(Web / 미니프로그램 / App)**와 **서버 SDK(Go / Java)**가 동작하는 네트워크 위치와 런타임 환경은 완전히 다릅니다. 엔지니어는 각 SDK 시나리오에서 다음 필드의 파라미터 전달 책임을 주의 깊게 확인해야 합니다:

| 필드 / 속성 | 클라이언트 SDK (`ts-web` / `mobile` Flutter·Android·iOS) | 서버 SDK (`go` / `java` / `python` / `nodejs` / `csharp` / `php` / `ruby`) | 네이티브 HTTP 직결 (`RESTFUL_API.md`) | 백엔드 게이트웨이 (`:8081`) 및 Flink ETL 처리 규칙 |
| :--- | :--- | :--- | :--- | :--- |
| **`project_id` & `project_token`** | **초기화 시 필수** (`init` 시 1회 전달) | **초기화 Consumer 시 필수** | **매 요청 최상위 필수** | 게이트웨이가 프로젝트 활성화 상태 및 토큰 서명을 검증하며, 유효하지 않으면 즉시 `401/403` 반환 |
| **`event_name` (이벤트명)** | **매 `track` 호출 시 필수** (`userSet*` 등 프로필 메서드는 SDK가 자동으로 `$user_*` 입력) | **매 `Track` 호출 시 필수** (`UserSet*` 등 프로필 메서드는 SDK가 자동으로 `$user_*` 입력) | **매 이벤트 건별 필수** | `<= 128` 자 및 명명 규칙 `^[A-Za-z_][A-Za-z0-9_]*$`(또는 시스템 `$`/`#` 화이트리스트) 검증 |
| **사용자 식별자 (`distinct_id` / `login_id`)** | **자동 관리 (매번 전달 불필요)**: SDK 초기화 시 방문자 `distinct_id` 자동 생성 및 영구 저장. 사용자 로그인 시 `login(accountId)` 호출로 로컬에 `login_id` 저장(이후 이벤트에 듀얼 ID 자동 포함) | **매 호출 시 필수**: 서버 인스턴스는 모든 사용자가 공유하므로 로컬 세션 상태가 없음. 매 호출 시 현재 사용자의 `login_id`(`accountId`) 또는 프론트엔드에서 전달받은 방문자 `distinct_id`를 명시적으로 전달(최소 하나 필수, `login_id`를 `distinct_id`로 역입력 금지) | **매 이벤트 건별 필수** (`distinct_id`와 `login_id` 중 최소 하나 필수) | 게이트웨이가 식별자 누락(`missing_identity`) 차단. 임의 이벤트에 비어 있지 않은 `distinct_id` + `login_id`가 동시 포함되면 Flink가 `abi.identity_map`에 실시간 기록하여 기여도 매핑 완성 |
| **사용자 공인 IP (`#ip` / `$ip`)**<br/>*(국가/도·시/도시 지역 분석에 영향)* | **클라이언트 전달 안 함 (가져올 수도 없음)**: 브라우저 JS와 모바일 앱은 NAT 뒤에 위치하여 자체 공인 IP 확인 불가. 수집 게이트웨이가 HTTP 연결에서 직접 추출 | **서버 환경 전달 강력 권장**: 서버에서 수집 시 게이트웨이가 확인하는 IP는 **백엔드 서버/컨테이너 IP**임(`LoggerConsumer` 파일 로깅 시 연결 IP 없음). 서버는 클라이언트 요청 헤더(`X-Forwarded-For` / `X-Real-IP`)에서 실제 사용자 IP를 가져와 `properties["#ip"]` 또는 `"$ip"`에 전달해야 함 | 클라이언트 직결 시 전달 불필요. 서버 프록시/전송 시 **`properties` 내에 `"#ip"` 또는 `"$ip"` 전달 필요** | Flink는 **`properties["#ip"]` > `properties["$ip"]` > 게이트웨이 연결 `client_ip`** 우선순위에 따라 유효한 IP를 추출하여 GeoIP(국가/시/군/구)를 해석하고, `properties`에서 `#ip`/`$ip`를 자동 제거 |
| **이벤트 발생 시간 (`timestamp` / `#time` / `$time`)** | **기본 전달 불필요**: 클라이언트 실시간 발생 시 SDK가 `Date.now()` 자동 적용. 과거 오프라인 이벤트 보정 시에만 `#time` / `$time` 또는 `options.timestamp` 전달 | **실시간 전달 불필요 / 비동기 및 데이터 보정 시 필수**: 실시간 트래킹은 서버 현재 시간 적용. **MQ 비동기 소비, 결제 콜백 또는 과거 데이터 적재**의 경우 반드시 `properties["#time"]`(또는 `TrackOptions.Timestamp` / `Date` / `Instant`)에 실제 비즈니스 발생 시각 전달 | **매 이벤트 건별 필수** (최상위 밀리초 `timestamp` 또는 `properties["#time"]` / `"$time"` 전달) | 게이트웨이와 SDK 모두 `#time` / `$time`을 최상위 밀리초 `timestamp`로 자동 추출 덮어쓰기 후 `properties`에서 제거. 프로젝트 시간 윈도우 `ts_window_days` 초과 시 차단 또는 마킹 |
| **이벤트 멱등성 기본키 (`event_id`)** | **기본 전달 불필요**: SDK가 UUIDv4 자동 생성, 네트워크 재연결 재전송 시 기존 `event_id` 자동 유지. D7① / G6 게이트에 따라 `trackFirst`/`trackUpdate`/`trackOverwrite`는 미지원 표기 | **일반 이벤트 전달 불필요 / 핵심 결제 거래 권장**: MQ 소비 또는 주문 상태 변경 시나리오에서는 `TrackWithOptions` / `trackWithId`를 통해 결정론적 비즈니스 키(예: `"ord_paid_" + orderNo`)를 전달하여 엔드투엔드 멱등성 보장 권장 | UUID 또는 비즈니스 키 전달 권장 (미전달 시 게이트웨이가 UUID 자동 생성하나 클라이언트 재시도 시 멱등성 보장 불가) | StarRocks `dwd_events`는 기본키와 `event_id`를 기반으로 동일 파티션 윈도우 내에서 멱등성 중복 제거 보장 |
| **디바이스 환경 속성 (`$os` / `$app_version` / `$screen_width` 등)** | **SDK 자동 수집 및 주입** (행동 이벤트에만 주입, `$user_*` 프로필 이벤트는 자동 격리) | **서버 환경 자동 감지 불가**: `SetSuperProperties`를 통해 서비스명/버전 설정 가능, 또는 클라이언트 요청 헤더에서 `$os`, `$app_version`, `$device_model` 추출 후 전달 | 필요에 따라 `properties` 내 명시적 전달 | Flink가 `$os`, `$app_version`, `$device_model` 등을 `dwd_events` 물리 가속 컬럼으로 자동 승격 |

> **프론트엔드-백엔드 협업 연동 모범 사례 (Best Practice)**: 동일한 비즈니스에서 프론트엔드 탐색(Web/App SDK)과 백엔드 주문 처리(Go/Java 등 서버 SDK)가 공존하는 경우, 프론트엔드가 백엔드 주문 API를 호출할 때 요청 헤더(예: `X-ABI-Distinct-Id: abi.getDistinctId()`)를 통해 프론트엔드 방문자 ID를 백엔드로 전달하는 것을 권장합니다. 백엔드는 서버 SDK `Track`을 호출할 때 `loginId`(`accountId`), 방문자 `distinctId`, 클라이언트 실제 `"#ip"`를 함께 전달함으로써 임의의 비즈니스 이벤트에서 Flink ID-Mapping 연결을 자동 트리거하여 "프론트엔드 노출 탐색 → 백엔드 결제 완료"의 전체 퍼널 기여도 분석과 실제 지역 복원을 완벽하게 구현할 수 있습니다.

---

## 3. 플랫폼별 대화형 데모 및 코드 예제 빠른 참조표

`abi.sdk`는 모든 언어 및 클라이언트 프레임워크에 대해 완전한 코드 문서 주석(`GoDoc`, `Javadoc`, `TSDoc`, `DartDoc`, `KDoc`, `SwiftDoc`)을 제공합니다. 또한 모든 사용자 대상 비주얼 데모 및 CLI/메서드 레벨 데모는 **"1. 파라미터 설정 및 단일 요청 페이로드 JSON 실시간 미리보기 → 2. '확인 및 전송' 명시적 클릭(또는 제출 메서드 호출)으로 단일 응답 확인"**의 2단계 인터랙티브 패턴을 통일 적용하여, 파라미터 조정 시 모니터링 영역에 무한히 누적되는 중복 로그를 방지합니다:

| 플랫폼 / SDK | 인터랙티브 UI / 실행 가능한 데모 파일 | 주석 포함 핵심 SDK 소스코드 | 실행 방법 및 검증 명령어 |
|------------|-----------------------------------|----------------------|--------------------|
| **Go 서버 SDK** | [`go/examples/demo/main.go`](go/examples/demo/main.go) & [`go/example_test.go`](go/example_test.go) | [`go/abi.go`](go/abi.go) (`StagingConsumer` 포함) | `cd abi.sdk/go && go run ./examples/demo` (요청 JSON 대화형 미리보기 후 `y` 입력하여 전송, 또는 `--yes` 추가로 자동 전송) |
| **Java 11+ 서버 SDK** | [`java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java`](java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) | [`java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java`](java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java) & [`StagingConsumer.java`](java/src/main/java/com/anylink/abi/sdk/StagingConsumer.java) | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test-compile exec:java -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"` |
| **Python 3 서버 SDK** | [`python/examples/demo.py`](python/examples/demo.py) | [`python/abi_sdk.py`](python/abi_sdk.py) (`StagingConsumer` 포함) | `python3 abi.sdk/python/examples/demo.py --yes` (요청 JSON 미리보기 후 전송 확인) |
| **Node.js 서버 SDK** | [`nodejs/examples/demo.mjs`](nodejs/examples/demo.mjs) | [`nodejs/src/index.mjs`](nodejs/src/index.mjs) (`StagingConsumer` 포함) | `node abi.sdk/nodejs/examples/demo.mjs --yes` |
| **C# (.NET) 서버 SDK** | [`csharp/Program.cs`](csharp/Program.cs) | [`csharp/AbiAnalytics.cs`](csharp/AbiAnalytics.cs) (`StagingConsumer` 포함) | `dotnet run --project abi.sdk/csharp -- --yes` |
| **PHP 8.1+ 서버 SDK** | [`php/examples/demo.php`](php/examples/demo.php) | [`php/src/AbiAnalytics.php`](php/src/AbiAnalytics.php) (`StagingConsumer` 포함) | `php abi.sdk/php/examples/demo.php --yes` |
| **Ruby 서버 SDK** | [`ruby/examples/demo.rb`](ruby/examples/demo.rb) | [`ruby/lib/abi_sdk.rb`](ruby/lib/abi_sdk.rb) (`StagingConsumer` 포함) | `ruby abi.sdk/ruby/examples/demo.rb --yes` |
| **C / C++17 크로스 플랫폼 SDK** | [`cpp/examples/demo.cpp`](cpp/examples/demo.cpp) | [`cpp/include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp) (`StagingConsumer` 및 `extern "C"` 포함) | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && /tmp/abi_cpp_demo --yes` |
| **Lua 5.3+ 크로스 플랫폼 SDK** | [`lua/examples/demo.lua`](lua/examples/demo.lua) | [`lua/abi_sdk.lua`](lua/abi_sdk.lua) (`StagingConsumer` 포함) | `lua abi.sdk/lua/examples/demo.lua --yes` |
| **Web / H5 대화형 샌드박스** | [`ts-web/examples/interactive-demo.html`](ts-web/examples/interactive-demo.html) & [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts) (`previewAndConfirmWebSdkExample`) | [`ts-web/src/index.ts`](ts-web/src/index.ts) (`buildPendingBatchPayload`) | 브라우저에서 `ts-web/examples/interactive-demo.html`을 열어 파라미터 설정 및 JSON 미리보기 후 '확인 및 전송' 클릭, 또는 `cd abi.sdk/ts-web && pnpm test` 실행 |
| **App 내장 H5 WebView 연동 & H5 게임 엔진** | [`ts-web/test/abi-web-sdk.test.ts`](ts-web/test/abi-web-sdk.test.ts) | [`ts-web/src/adapters/h5-bridge.ts`](ts-web/src/adapters/h5-bridge.ts) & [`ts-web/src/adapters/game-engines.ts`](ts-web/src/adapters/game-engines.ts) | `cd abi.sdk/ts-web && pnpm test` (Android/iOS WebView Bridge 및 Cocos Creator / Egret / LayaAir / Weex 커버리지 검증) |
| **ABI 관리자 콘솔 내장 연동 가이드** | [`../abi.cli/src/pages/Meta/MetaProjects.tsx`](../abi.cli/src/pages/Meta/MetaProjects.tsx) & [`../abi.cli/src/lib/sdk-guide-token.ts`](../abi.cli/src/lib/sdk-guide-token.ts) | 상동 | 관리자 콘솔 "메타데이터 → 프로젝트 관리 → 연동 가이드"에서 시나리오/공통 속성을 선택하여 단일 JSON 미리보기 후 '확인 및 전송' 클릭 |
| **위챗 미니프로그램 & React Native** | [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts) (`runWeChatMiniProgramExample`, `runReactNativeExample`) | [`ts-web/src/adapters/miniapp.ts`](ts-web/src/adapters/miniapp.ts) & [`ts-web/src/adapters/react-native.ts`](ts-web/src/adapters/react-native.ts) | 어댑터 데모 함수 호출 또는 `cd abi.sdk/ts-web && pnpm test` 실행 |
| **Unity 게임 엔진 클라이언트 SDK** | [`game-engines/unity/AbiUnityDemoMonoBehaviour.cs`](game-engines/unity/AbiUnityDemoMonoBehaviour.cs) (`AbiUnityDemoMonoBehaviour` / `AbiUnityDemoRunner`) | [`game-engines/unity/AbiUnityAnalytics.cs`](game-engines/unity/AbiUnityAnalytics.cs) (`BuildPendingBatchJson`) | Unity에서 `AbiUnityDemoMonoBehaviour`를 마운트하거나 `dotnet run --project abi.sdk/csharp -- --test` 실행 |
| **Flutter 모바일 클라이언트 SDK** | [`mobile/flutter/example/lib/main.dart`](mobile/flutter/example/lib/main.dart) (`AbiSdkDemoApp` / `AbiSdkDemoScreen`) | [`mobile/flutter/lib/abi_sdk.dart`](mobile/flutter/lib/abi_sdk.dart) (`buildPendingBatchPayload` / `previewScenarioPayload` + `confirmSubmit`) | Flutter 호스트 프로젝트에서 `AbiSdkDemoApp`을 마운트하여 JSON 미리보기 후 '확인 및 전송' 클릭, 또는 `previewScenarioPayload` + `confirmSubmit` 호출([`mobile/README.md`](mobile/README.md) 참조) |
| **Android Kotlin 모바일 클라이언트 SDK** | [`mobile/android/example/AbiDemoActivity.kt`](mobile/android/example/AbiDemoActivity.kt) (`AbiDemoActivity` / `previewScenarioPayload` + `confirmSubmit`) | [`mobile/android/AbiAnalytics.kt`](mobile/android/AbiAnalytics.kt) (`buildPendingBatchPayload`) | Android 호스트 프로젝트에서 `AbiDemoActivity`를 시작하여 단일 요청 JSON 미리보기 후 '확인 및 전송' 클릭, 또는 `previewScenarioPayload` + `confirmSubmit` 호출([`mobile/README.md`](mobile/README.md) 참조) |
| **iOS Swift 모바일 클라이언트 SDK** | [`mobile/ios/example/AbiDemoViewController.swift`](mobile/ios/example/AbiDemoViewController.swift) (`AbiSdkDemoView` / `AbiSdkDemoRunner`) | [`mobile/ios/AbiAnalytics.swift`](mobile/ios/AbiAnalytics.swift) (`buildPendingBatchJsonString`) | SwiftUI 프로젝트에서 `AbiSdkDemoView()`를 마운트하여 요청 JSON 미리보기 후 '확인 및 전송' 클릭(또는 `AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit` 호출). 타입 검증: `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| **LogBus 2 / 데이터 적재 도구 스위트** | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) (`--demo` 2단계 미리보기 및 확인 전송) | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) 및 Filebeat / Logstash / Vector / DataX 설정 템플릿 | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |
