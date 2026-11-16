# Bộ SDK thu thập dữ liệu đa ngôn ngữ ABI (`abi.sdk`)

**Ngôn ngữ / Language**: [简体中文](README.md) | [繁體中文](README.zh-TW.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Português](README.pt.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Русский](README.ru.md) | **[Tiếng Việt](README.vi.md)** | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md)

Gói `abi.sdk` cung cấp bộ SDK thu thập dữ liệu phía máy khách (Client) và phía máy chủ (Server) chuẩn sản xuất cho nền tảng Phân tích Hành vi Người dùng (UBA) & Business Intelligence (BI) ABI. Được đối chuẩn theo đặc tả [ThinkingData SDK v3.4](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html), bộ công cụ này đồng bộ chặt chẽ định dạng giao thức mạng, ánh xạ danh tính kép (dual-ID) và xác thực lược đồ dữ liệu với Cổng thu thập ABI [`abi.srv`](../abi.srv/) (`:8081`) cùng các động cơ xử lý luồng [`abi.flink`](../abi.flink/) (Job1 ETL thời gian thực & Job2 tiếp nhận dữ liệu thô ODS).

---

## 1. Cấu trúc thư mục, mục lục tài liệu đa ngôn ngữ & Ma trận nền tảng

| Thư mục | Nền tảng mục tiêu / Gói | README đa ngôn ngữ (ZH / EN / JA) | Khả năng cốt lõi | Lệnh kiểm tra xác minh |
|---|---|---|---|---|
| [`RESTFUL_API.md`](RESTFUL_API.md) | HTTP RESTful API độc lập với ngôn ngữ | [中文](RESTFUL_API.md) | Hướng dẫn tích hợp trực tiếp qua HTTP không phụ thuộc thư viện ngoài: đặc tả tải trọng đơn lẻ và hàng loạt, các ví dụ `curl` định dạng JSON (tự động ánh xạ 2 ID, tính lũy thừa khi gửi lại trong cùng ngày, 7 thao tác hồ sơ `$user_*`, nén Gzip, các chế độ `debug` & `dry_run`), cùng mã nguồn mẫu cho Python / Node.js | Xem các lệnh `curl` với cờ `dry_run: true` trong tài liệu |
| [`spec/test-vectors/`](spec/test-vectors/) | Bộ vector kiểm thử vàng xuyên ngôn ngữ | — | Các bộ vector kiểm thử JSON chuẩn hóa chung: chuẩn hóa danh tính (giới hạn UTF-8 64/128 byte, loại bỏ khoảng trắng Unicode, từ chối ký tự điều khiển ASCII), xác thực khóa sự kiện & thuộc tính, bảo vệ độ chính xác số nguyên 64-bit `> 2^53 - 1` và quy tắc thao tác `$user_*` | Được thực thi bởi bộ kiểm thử đơn vị của từng SDK |
| [`ts-web/`](ts-web/) | Web / H5 / TypeScript (`@anylink/abi-web-sdk`) + Cầu nối App-H5 WebView, MiniProgram, RN & Bộ điều hợp Game Engine H5 | [中文](ts-web/README.md) · [EN](ts-web/README.en.md) · [JA](ts-web/README.ja.md)<br/>Ví dụ: [中文](ts-web/examples/README.md) · [EN](ts-web/examples/README.en.md) · [JA](ts-web/examples/README.ja.md) | Hỗ trợ `init`, `identify`, `login`, `logout`, `track`, `timeEvent`, `setSuperProperties`, `setDynamicSuperProperties`, toàn bộ 7 thao tác hồ sơ `$user_*`, tự động theo dõi SPA `$pageview` & `$AppEnd`, cầu nối App-H5 WebView (`createH5AppBridgeAdapter`), bộ điều hợp game H5 (`createCocosCreatorAdapter`, `createEgretAdapter`, `createLayaAirAdapter`, `createWeexAdapter`), và gửi dữ liệu khi đóng trang qua `sendBeacon` (*Lưu ý: trong phiên bản hiện tại theo cổng kiểm soát D7① / G6, các thao tác trackFirst/trackUpdate/trackOverwrite chưa được hỗ trợ*) | `cd abi.sdk/ts-web && pnpm test` |
| [`go/`](go/) | Server SDK cho Go (`abi.sdk/go`) | [中文](go/README.md) · [EN](go/README.en.md) · [JA](go/README.ja.md)<br/>Demo: [中文](go/examples/demo/README.md) · [EN](go/examples/demo/README.en.md) · [JA](go/examples/demo/README.ja.md) | Máy khách `AbiAnalytics` an toàn luồng với 4 loại Consumer: `StagingConsumer` (xem trước JSON yêu cầu 2 bước & xác nhận gửi), `BatchConsumer` (HTTP đệm bất đồng bộ + Gzip + thử lại số mũ), `LoggerConsumer` (xoay vòng tệp JSONL cục bộ theo ngày/giờ/dung lượng cho Filebeat/LogBus) và `DebugConsumer` (xác thực L4 đồng bộ & `dry_run`) | `cd abi.sdk/go && go test -race ./...` |
| [`java/`](java/) | Server SDK cho Java 11+ (`com.anylink.abi:abi-java-sdk`) | [中文](java/README.md) · [EN](java/README.en.md) · [JA](java/README.ja.md) | Máy khách `AbiAnalytics` an toàn luồng (`AutoCloseable`), cung cấp `StagingConsumer`, `BatchConsumer`, `LoggerConsumer` và `DebugConsumer`, tự động tuần tự hóa chuỗi không mất mát cho các số nguyên 64-bit vượt quá phạm vi an toàn IEEE-754 (`> 2^53 - 1`) | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test` |
| [`python/`](python/) | Server SDK cho Python 3 (`abi.sdk/python`) | [中文](python/README.md) · [EN](python/README.en.md) · [JA](python/README.ja.md) | Triển khai bằng thư viện chuẩn Python 3 không phụ thuộc bên ngoài: `StagingConsumer`, `BatchConsumer` (luồng ngầm daemon + Gzip + thử lại), `LoggerConsumer`, `DebugConsumer`, tự động chuyển đổi số nguyên lớn `> 2^53 - 1` thành chuỗi, trích xuất `#time`/`$time` và chuyển tiếp `#ip`/`$ip` | `python3 -m unittest discover -s abi.sdk/python/tests -v` |
| [`nodejs/`](nodejs/) | Server SDK cho Node.js (`@anylink/abi-node-sdk`) | [中文](nodejs/README.md) · [EN](nodejs/README.en.md) · [JA](nodejs/README.ja.md) | Triển khai ESM không phụ thuộc thư viện ngoài kèm định nghĩa TypeScript (`index.d.ts`) cho backend Express / Fastify / Koa / NestJS: `StagingConsumer`, `BatchConsumer` (`zlib.gzipSync`), `LoggerConsumer`, `DebugConsumer` và tuần tự hóa chuỗi an toàn cho `BigInt` | `node --test abi.sdk/nodejs/test/abi-node-sdk.test.mjs` |
| [`csharp/`](csharp/) | Server SDK cho C# / .NET (`Anylink.Abi.Sdk`) | [中文](csharp/README.md) · [EN](csharp/README.en.md) · [JA](csharp/README.ja.md) | Server SDK dùng thư viện chuẩn .NET (`System.Text.Json`, `HttpClient`, `GZipStream`) không cần gói NuGet ngoài với `StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, `DebugConsumer` và đầy đủ các phương thức `Track*` / `User*` | `dotnet run --project abi.sdk/csharp -- --test` |
| [`php/`](php/) | Server SDK cho PHP 8.1+ (`Anylink\Abi\Sdk`) | [中文](php/README.md) · [EN](php/README.en.md) · [JA](php/README.ja.md) | Server SDK PHP không phụ thuộc cho Laravel / Symfony / PHP-FPM / Swoole với `StagingConsumer`, `BatchConsumer` (`gzencode` + thử lại), `LoggerConsumer` và `DebugConsumer` | `php abi.sdk/php/tests/abi_sdk_test.php` |
| [`ruby/`](ruby/) | Server SDK cho Ruby (`AbiSdk`) | [中文](ruby/README.md) · [EN](ruby/README.en.md) · [JA](ruby/README.ja.md) | Server SDK Ruby dùng thư viện chuẩn không phụ thuộc gem ngoài cho Rails / Sidekiq / Rack (hỗ trợ cả kiểu gọi `snake_case` và `camelCase`) với `StagingConsumer`, `BatchConsumer`, `LoggerConsumer` và `DebugConsumer` | `ruby abi.sdk/ruby/test/abi_sdk_test.rb` |
| [`cpp/`](cpp/) | SDK cho C / C++17 (Server & Client Game Unreal Engine / Cocos2d-x) | [中文](cpp/README.md) · [EN](cpp/README.en.md) · [JA](cpp/README.ja.md) | SDK tệp tiêu đề duy nhất C++17 ([`include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)) xuất chuẩn `extern "C"` C ABI; hỗ trợ cả chế độ máy chủ không trạng thái và chế độ máy khách game (`enable_client_mode`, `identify`, `login`, `logout`, `time_event`) | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && /tmp/abi_cpp_test` |
| [`lua/`](lua/) | SDK cho Lua 5.3+ (Server OpenResty / Skynet & Client Cocos2d-Lua) | [中文](lua/README.md) · [EN](lua/README.en.md) · [JA](lua/README.ja.md) | SDK tệp đơn thuần Lua 5.3+ không phụ thuộc ngoài ([`abi_sdk.lua`](lua/abi_sdk.lua)) tích hợp sẵn bộ mã hóa JSON và xác thực UTF-8, hỗ trợ cả chế độ máy chủ và máy khách | `lua abi.sdk/lua/tests/test_abi_sdk.lua` |
| [`mobile/`](mobile/) | SDK Ứng dụng di động (Flutter Dart, Android Kotlin, iOS Swift) | Tổng quan: [中文](mobile/README.md) · [EN](mobile/README.en.md) · [JA](mobile/README.ja.md)<br/>Flutter: [中文](mobile/flutter/README.md) · [EN](mobile/flutter/README.en.md) · [JA](mobile/flutter/README.ja.md)<br/>Android: [中文](mobile/android/README.md) · [EN](mobile/android/README.en.md) · [JA](mobile/android/README.ja.md)<br/>iOS: [中文](mobile/ios/README.md) · [EN](mobile/ios/README.en.md) · [JA](mobile/ios/README.ja.md) | Hàng đợi ngoại tuyến an toàn luồng gốc & gửi định kỳ theo lô, ràng buộc danh tính kép (`identify` / `login` / `logout`), bấm giờ đơn điệu (`timeEvent` -> `$duration`), tính lũy thừa theo `event_id` cố định trong ngày (`trackFirst`/`trackUpdate`/`trackOverwrite` không hỗ trợ theo D7① / G6), đầy đủ các thao tác hồ sơ `$user_*` và bản demo giao diện trực quan 2 bước xem trước - xác nhận gửi | `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| [`game-engines/unity/`](game-engines/unity/) | SDK Khách cho Game Engine Unity (C# `AbiUnityAnalytics`) | [中文](game-engines/unity/README.md) · [EN](game-engines/unity/README.en.md) · [JA](game-engines/unity/README.ja.md) | SDK khách Unity C# với định danh phiên thiết bị bền vững, bấm giờ đơn điệu, hàng đợi ngoại tuyến và bản demo xác nhận 2 bước `AbiUnityDemoMonoBehaviour` | `dotnet run --project abi.sdk/csharp -- --test` |
| [`data-import/`](data-import/) | Các bộ chuyển tiếp nhập dữ liệu & truyền tải dòng (LogBus 2 / Filebeat / Logstash / Vector / DataX) | [中文](data-import/README.md) · [EN](data-import/README.en.md) · [JA](data-import/README.ja.md) | Trình nền ABI LogBus 2 ([`abi_logbus.py`](data-import/abi_logbus.py), theo dõi các tệp `.jsonl` do `LoggerConsumer` tạo ra với lưu điểm kiểm tra vị trí & tải lên lô nén Gzip) cùng các mẫu cấu hình sẵn có cho Filebeat, Logstash, Vector và Alibaba DataX | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |

---

## 2. Giao thức mạng gửi dữ liệu theo lô qua cổng thu thập (`POST /collect/api/v1/track/batch`)

Tất cả các Consumer HTTP phía máy khách và máy chủ đều gửi tải trọng JSON theo lô tiêu chuẩn đến cổng thu thập:

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

### 2.1 Ràng buộc danh tính kép và tính lũy thừa chuẩn ThinkingData

- **`distinct_id` (ID Khách truy cập / Thiết bị)**: Định danh duy nhất của khách truy cập hoặc thiết bị khách trên đường truyền mạng. Các ký tự điều khiển ASCII (`0x00–0x08`, `0x0E–0x1F`, `0x7F`) bị từ chối, khoảng trắng Unicode đầu và cuối chuỗi được cắt tỉa, độ dài tối đa là **64 byte UTF-8**. Các SDK máy khách tự động tạo và lưu trữ `distinct_id` cục bộ (có thể ghi đè qua `identify(visitorId)`); các SDK máy chủ có thể gửi chuỗi rỗng `""` khi gửi các sự kiện tài khoản thuần túy đã có `login_id` hợp lệ (**tuyệt đối không sao chép hoặc cắt ngắn `login_id` vào `distinct_id`**).
- **`login_id` (ID Tài khoản đã xác thực)**: Định danh tài khoản nghiệp vụ đã xác thực; độ dài tối đa là **128 byte UTF-8** (để trống hoặc `""` cho khách truy cập chưa xác thực). Ít nhất một trong hai trường `distinct_id` hoặc `login_id` **phải không rỗng** trên mỗi sự kiện.
- **Hàm `login()` cục bộ trên Client & Tự động ánh xạ ID trên Flink**: Việc gọi `login(accountId)` trên các SDK máy khách **chỉ cập nhật `login_id` trong trạng thái cục bộ**, không ghi đè lên `distinct_id` và không phát sự kiện hệ thống ràng buộc danh tính riêng biệt; gọi `logout()` sẽ xóa `login_id` trong khi vẫn giữ nguyên `distinct_id` hiện tại. Trên cả SDK máy khách và máy chủ: **bất cứ khi nào một sự kiện hành vi (`Track*`) hoặc thao tác hồ sơ (`$user_*`) chứa đồng thời cả `distinct_id` và `login_id` không rỗng**, Flink Job1 sẽ tự động ánh xạ và liên kết chúng trong bảng `abi.identity_map` theo thời gian thực.
- **`event_id` (Khóa chính lũy thừa)**: Độ dài tối đa là **64 byte UTF-8**. Được giữ nguyên khi gửi lại từ hàng đợi ngoại tuyến khi mạng lỗi, gặp mã lỗi HTTP `429` hoặc `5xx`, đảm bảo tính lũy thừa khi tiếp nhận dữ liệu. (*Lưu ý: theo cổng kiểm soát D7① / G6, tính năng loại bỏ trùng lặp trackFirst và các sự kiện có thể chỉnh sửa trackUpdate/trackOverwrite chưa được hỗ trợ trong phiên bản hiện tại; để đảm bảo tính lũy thừa, hãy truyền một giá trị event_id xác định cố định trong track trong cùng một cửa sổ phân vùng*).

### 2.2 Bảo vệ độ chính xác số nguyên lớn ($> 2^{53}-1$)

JavaScript và các bộ phân tích cú pháp JSON tiêu chuẩn sử dụng số thực dấu phẩy động độ chính xác kép IEEE-754 với số nguyên an toàn tối đa là $2^{53}-1$ (`9007199254740991`).

- Bất cứ khi nào giá trị tuyệt đối của một thuộc tính số nguyên vượt quá `9007199254740991` (ví dụ: mã đơn hàng Snowflake 64-bit như `9007199254740993` hoặc `Int64.min` / `Long.MIN_VALUE`), mỗi SDK ABI sẽ tự động tuần tự hóa nó dưới dạng chuỗi thập phân (`"9007199254740993"`) nhằm ngăn ngừa việc cắt cụt các bit thấp.
- Tất cả các SDK cũng từ chối các giá trị `NaN`, `Infinity` / `-Infinity`, các phần tử `null` trong danh sách và các đối tượng/mảng lồng nhau bên trong các thuộc tính kiểu danh sách trước khi đưa vào hàng đợi.

### 2.3 Các thao tác hồ sơ người dùng `$user_*`

Tất cả các SDK cung cấp 7 phương thức đột biến hồ sơ người dùng tiêu chuẩn được định tuyến đến bảng khóa chính StarRocks `abi.dim_users`:

| Phương thức SDK | Tên mạng `event_name` | Ngữ nghĩa thay đổi hồ sơ |
|---|---|---|
| `userSet(props)` | `$user_set` | Ghi đè các thuộc tính hồ sơ người dùng mới nhất (thêm mới nếu chưa có, cập nhật nếu đã tồn tại) |
| `userSetOnce(props)` | `$user_set_once` | Khởi tạo các thuộc tính hồ sơ người dùng chỉ khi trường đó hiện đang có giá trị null (ví dụ: kênh thu nạp đầu tiên, nguồn đăng ký) |
| `userAdd(props)` | `$user_add` | Tăng/giảm nguyên tử các thuộc tính hồ sơ người dùng dạng số (ví dụ: điểm tích lũy, tổng chi tiêu) |
| `userUnset(keys)` | `$user_unset` | Xóa các cột thuộc tính hồ sơ người dùng chỉ định (`NULL` trong `dim_users`) |
| `userAppend(props)` | `$user_append` | Thêm các phần tử vào thuộc tính hồ sơ người dùng kiểu danh sách/mảng |
| `userUniqAppend(props)` | `$user_uniq_append` | Thêm các phần tử vào thuộc tính hồ sơ người dùng kiểu danh sách/mảng có tự động loại bỏ trùng lặp |
| `userDelete()` | `$user_del` | Xóa hàng hồ sơ của người dùng hiện tại khỏi bảng `abi.dim_users` (`StarRocksSinkOP.DELETE`) trong khi vẫn lưu giữ các sự kiện hành vi lịch sử trong bảng `dwd_events` |

> **Quy tắc cô lập**: Khi tạo các sự kiện `$user_*` (hoặc `#user_*`), các SDK **tuyệt đối không tiêm** các Siêu thuộc tính (Super Properties) tĩnh/động hoặc các thuộc tính môi trường cài sẵn (`$os`, `$app_version`, `$lib`), ngăn không cho siêu dữ liệu môi trường làm bẩn bảng `abi.dim_users`.

### 2.4 Hướng dẫn cho Kỹ sư tích hợp: Yêu cầu về các trường & Phân định trách nhiệm giữa Client và Server (Quan trọng)

Trong kiến trúc sản xuất, **SDK máy khách (Web / Mini-Program / Mobile App)** và **SDK máy chủ (Go / Java / Python / Node / C# / PHP / Ruby)** hoạt động trong các cấu trúc mạng hoàn toàn khác nhau. Kỹ sư tích hợp cần chú ý sự khác biệt về trách nhiệm của các trường:

| Trường / Thuộc tính | SDK Máy khách (`ts-web` / `mobile` Flutter·Android·iOS) | SDK Máy chủ (`go` / `java` / `python` / `nodejs` / `csharp` / `php` / `ruby`) | Giao diện HTTP trực tiếp (`RESTFUL_API.md`) | Hành vi của Cổng (`:8081`) & Flink ETL |
| :--- | :--- | :--- | :--- | :--- |
| **`project_id` & `project_token`** | **Bắt buộc một lần khi `init()`** | **Bắt buộc khi khởi tạo Consumer** | **Bắt buộc ở cấp cao nhất của mọi yêu cầu** | Cổng kiểm tra trạng thái và token dự án; trả về `401/403` nếu không hợp lệ |
| **`event_name`** | **Bắt buộc trên mỗi lần `track()`** (tự động đặt thành `$user_*` bởi các hàm `userSet*()`) | **Bắt buộc trên mỗi lần `Track()`** (tự động đặt thành `$user_*` bởi các hàm `UserSet*()`) | **Bắt buộc trên mỗi sự kiện** | Được xác thực độ dài `<= 128` ký tự và regex `^[A-Za-z_][A-Za-z0-9_]*$` (hoặc danh sách trắng hệ thống `$`/`#`) |
| **Định danh người dùng (`distinct_id` / `login_id`)** | **Tự động quản lý (không cần truyền trong `track`)**: SDK tự động tạo và lưu trữ `distinct_id` của khách khi `init()`; lập trình viên gọi `login(accountId)` để lưu `login_id` cục bộ (các sự kiện tiếp theo tự động mang cả 2 ID) | **BẮT BUỘC trên MỌI lệnh gọi**: Server SDK là một singleton không trạng thái dùng chung cho mọi người dùng; lập trình viên **phải truyền tường minh** `login_id` (`accountId`) và/hoặc `distinct_id` do client chuyển tiếp (ít nhất một trường không rỗng; không sao chép `login_id` vào `distinct_id`) | **Bắt buộc trên mỗi sự kiện** (ít nhất một trong `distinct_id` / `login_id` phải không rỗng) | Cổng từ chối sự kiện thiếu danh tính (`missing_identity`); khi sự kiện có cả 2 ID không rỗng, Flink tự động liên kết chúng trong `abi.identity_map` |
| **IP công cộng người dùng (`#ip` / `$ip`)**<br/>*(Dùng cho GeoIP: Quốc gia / Tỉnh / Thành phố)* | **KHÔNG truyền (Client không lấy được)**: Trình duyệt và ứng dụng di động nằm sau NAT, không thể đọc chính xác IP công cộng; Cổng sẽ tự động trích xuất IP từ kết nối HTTP | **BẮT BUỘC do Server truyền**: Khi backend Go/Java gọi cổng, IP kết nối TCP mà cổng thấy là **IP của IDC/VPC backend** (hoặc không có với `LoggerConsumer`). Kỹ sư backend phải lấy IP thực từ tiêu đề (`X-Forwarded-For` / `X-Real-IP`) và truyền vào `properties["#ip"]` hoặc `"$ip"` | Bỏ qua đối với các lệnh gọi trực tiếp từ client; **bắt buộc truyền trong `properties["#ip"]` hoặc `"$ip"` cho các cuộc gọi giữa các server** | Flink phân giải GeoIP theo thứ tự ưu tiên nghiêm ngặt: **`properties["#ip"]` > `properties["$ip"]` > `client_ip` của kết nối cổng**, kiểm tra định dạng IP và loại bỏ `#ip`/`$ip` khỏi `properties` |
| **Mốc thời gian sự kiện (`timestamp` / `#time` / `$time`)** | **Tự động điền (`Date.now()`)**: Bỏ qua đối với sự kiện thời gian thực; chỉ truyền `#time` / `$time` hoặc `options.timestamp` khi nạp bù dữ liệu lịch sử ngoại tuyến | **Tự động điền cho thời gian thực / Bắt buộc cho tác vụ bất đồng bộ & nạp bù**: Với hàng đợi MQ trễ, webhook thanh toán hoặc nạp dữ liệu lịch sử, hãy truyền tường minh thời gian nghiệp vụ thực tế qua `properties["#time"]` (hoặc `TrackOptions.Timestamp` / `Date` / `Instant`) | **Bắt buộc trên mỗi sự kiện** (hoặc `timestamp` ms ở cấp cao nhất hoặc `properties["#time"]` / `"$time"`) | SDK và Cổng trích xuất `#time` / `$time` thành `timestamp` ms cấp cao nhất và loại bỏ khỏi `properties`; kiểm tra theo cửa sổ `ts_window_days` |
| **Khóa lũy thừa (`event_id`)** | **Tự động tạo (UUIDv4)**: Tự động lưu giữ qua các lần thử lại ngoại tuyến; theo D7① / G6, `trackFirst`/`trackUpdate`/`trackOverwrite` chưa được hỗ trợ trong phiên bản hiện tại | **Tự động tạo mặc định / Khuyến nghị cho giao dịch**: Truyền khóa nghiệp vụ xác định (ví dụ: `"ord_paid_" + orderNo`) qua `TrackWithOptions` / `trackWithId` để chống trùng lặp khi thử lại MQ | Khuyến nghị (Cổng sẽ tự tạo UUID nếu bỏ qua, nhưng thử lại không có `event_id` cố định sẽ không thể chống trùng lặp) | Bảng StarRocks `dwd_events` sử dụng `event_id` để loại bỏ trùng lặp lũy thừa |
| **Ngữ cảnh thiết bị (`$os` / `$app_version` / `$screen_width`, v.v.)** | **Tự động thu thập & chèn bởi SDK** (chỉ chèn vào sự kiện hành vi; loại trừ khỏi `$user_*`) | **Không có trên máy chủ**: Thiết lập siêu dữ liệu dịch vụ qua `SetSuperProperties`, hoặc chuyển tiếp tiêu đề client (`$os`, `$app_version`, `$device_model`) trong `properties` | Truyền tường minh trong `properties` khi cần | Flink chuyển các trường `$os`, `$app_version`, `$device_model` thành các cột vật lý trong bảng `dwd_events` |

> **Thực hành tốt nhất để liên kết phễu Frontend + Backend**: Khi kết hợp duyệt web phía máy khách (Web/App SDK) với quy trình xử lý đơn hàng phía máy chủ (Go/Java/Python/Node/C#/PHP/Ruby SDK), hãy truyền ID khách truy cập của client (`abi.getDistinctId()`) lên API phía máy chủ của bạn (ví dụ: qua tiêu đề yêu cầu `X-ABI-Distinct-Id`). Phía máy chủ phải truyền cả `loginId` (`accountId`), `distinctId` của khách truy cập và địa chỉ `#ip` thực của người dùng khi gọi Server SDK. Flink sẽ tự động liên kết cả hai ID trên mọi sự kiện, đảm bảo phân bổ phễu xuyên đầu cuối liền mạch và xác định vị trí địa lý GeoIP chính xác.

---

## 3. Bản demo tương tác 2 bước & Bảng tra cứu ví dụ mã nguồn nhanh

Tất cả các bản demo giao diện trực quan và demo CLI/phương thức trong `abi.sdk` đều tuân theo **Quy trình 2 bước** thống nhất:
1. **Bước 1 (Cấu hình tham số & Xem trước JSON của một yêu cầu trực tiếp)**: Việc thay đổi danh tính, Siêu thuộc tính hoặc tham số sự kiện sẽ cập nhật **một bản xem trước JSON duy nhất của phần thân yêu cầu `POST /collect/api/v1/track/batch`** ngay tại chỗ (không làm tràn ngập màn hình bằng các dòng nhật ký vô tận).
2. **Bước 2 (Xác nhận & Gửi rõ ràng)**: Nhấp vào nút **«Xác nhận & Gửi»** (`确认提交`) hoặc xác nhận trong CLI sẽ gửi đúng gói tin vừa tạo và hiển thị phản hồi mới nhất từ cổng thu thập.

| Nền tảng / SDK | Giao diện trực quan / Điểm vào Demo chạy được | Mã nguồn SDK cốt lõi | Lệnh khởi chạy & kiểm tra |
|---|---|---|---|
| **Server SDK cho Go** | [`go/examples/demo/main.go`](go/examples/demo/main.go) & [`go/example_test.go`](go/example_test.go) | [`go/abi.go`](go/abi.go) (`StagingConsumer`) | `cd abi.sdk/go && go run ./examples/demo` (nhập `y` sau khi xem trước JSON, hoặc truyền `--yes`) |
| **Server SDK cho Java 11+** | [`java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java`](java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) | [`AbiAnalytics.java`](java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java) & [`StagingConsumer.java`](java/src/main/java/com/anylink/abi/sdk/StagingConsumer.java) | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test-compile exec:java -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"` |
| **Server SDK cho Python 3** | [`python/examples/demo.py`](python/examples/demo.py) | [`python/abi_sdk.py`](python/abi_sdk.py) (`StagingConsumer`) | `python3 abi.sdk/python/examples/demo.py --yes` |
| **Server SDK cho Node.js** | [`nodejs/examples/demo.mjs`](nodejs/examples/demo.mjs) | [`nodejs/src/index.mjs`](nodejs/src/index.mjs) (`StagingConsumer`) | `node abi.sdk/nodejs/examples/demo.mjs --yes` |
| **Server SDK cho C# (.NET)** | [`csharp/Program.cs`](csharp/Program.cs) | [`csharp/AbiAnalytics.cs`](csharp/AbiAnalytics.cs) (`StagingConsumer`) | `dotnet run --project abi.sdk/csharp -- --yes` |
| **Server SDK cho PHP 8.1+** | [`php/examples/demo.php`](php/examples/demo.php) | [`php/src/AbiAnalytics.php`](php/src/AbiAnalytics.php) (`StagingConsumer`) | `php abi.sdk/php/examples/demo.php --yes` |
| **Server SDK cho Ruby** | [`ruby/examples/demo.rb`](ruby/examples/demo.rb) | [`ruby/lib/abi_sdk.rb`](ruby/lib/abi_sdk.rb) (`StagingConsumer`) | `ruby abi.sdk/ruby/examples/demo.rb --yes` |
| **SDK Đa nền tảng C / C++17** | [`cpp/examples/demo.cpp`](cpp/examples/demo.cpp) | [`cpp/include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp) (`StagingConsumer` & `extern "C"`) | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && /tmp/abi_cpp_demo --yes` |
| **SDK Đa nền tảng Lua 5.3+** | [`lua/examples/demo.lua`](lua/examples/demo.lua) | [`lua/abi_sdk.lua`](lua/abi_sdk.lua) (`StagingConsumer`) | `lua abi.sdk/lua/examples/demo.lua --yes` |
| **Sân chơi tương tác Web / H5** | [`ts-web/examples/interactive-demo.html`](ts-web/examples/interactive-demo.html) & [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts) (`previewAndConfirmWebSdkExample`) | [`ts-web/src/index.ts`](ts-web/src/index.ts) (`buildPendingBatchPayload`) | Mở `ts-web/examples/interactive-demo.html` trong trình duyệt hoặc chạy `cd abi.sdk/ts-web && pnpm test` |
| **Cầu nối App-H5 WebView & Game Engine H5** | [`ts-web/test/abi-web-sdk.test.ts`](ts-web/test/abi-web-sdk.test.ts) | [`h5-bridge.ts`](ts-web/src/adapters/h5-bridge.ts) & [`game-engines.ts`](ts-web/src/adapters/game-engines.ts) | `cd abi.sdk/ts-web && pnpm test` (Cầu nối WebView Android/iOS + Cocos Creator / Egret / LayaAir / Weex) |
| **Ngăn kéo hướng dẫn SDK trong Bàn làm việc Quản trị ABI** | [`../abi.cli/src/pages/Meta/MetaProjects.tsx`](../abi.cli/src/pages/Meta/MetaProjects.tsx) & [`../abi.cli/src/lib/sdk-guide-token.ts`](../abi.cli/src/lib/sdk-guide-token.ts) | Tương tự như trên | Trong Bàn làm việc Quản trị «Siêu dữ liệu → Dự án → Hướng dẫn SDK», định cấu hình tham số để xem trước JSON và nhấp «Xác nhận & Gửi» |
| **Mini-Program WeChat & React Native** | [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts) (`runWeChatMiniProgramExample`, `runReactNativeExample`) | [`miniapp.ts`](ts-web/src/adapters/miniapp.ts) & [`react-native.ts`](ts-web/src/adapters/react-native.ts) | `cd abi.sdk/ts-web && pnpm test` |
| **SDK Khách cho Game Engine Unity** | [`game-engines/unity/AbiUnityDemoMonoBehaviour.cs`](game-engines/unity/AbiUnityDemoMonoBehaviour.cs) (`AbiUnityDemoMonoBehaviour` / `AbiUnityDemoRunner`) | [`game-engines/unity/AbiUnityAnalytics.cs`](game-engines/unity/AbiUnityAnalytics.cs) (`BuildPendingBatchJson`) | Gắn `AbiUnityDemoMonoBehaviour` trong Unity hoặc chạy `dotnet run --project abi.sdk/csharp -- --test` |
| **SDK Máy khách Flutter** | [`mobile/flutter/example/lib/main.dart`](mobile/flutter/example/lib/main.dart) (`AbiSdkDemoApp`) | [`mobile/flutter/lib/abi_sdk.dart`](mobile/flutter/lib/abi_sdk.dart) (`buildPendingBatchPayload` / `previewScenarioPayload` + `confirmSubmit`) | Khởi chạy `AbiSdkDemoApp` trong Flutter hoặc gọi `previewScenarioPayload` + `confirmSubmit` (xem [`mobile/flutter/README.en.md`](mobile/flutter/README.en.md)) |
| **SDK Máy khách Android Kotlin** | [`mobile/android/example/AbiDemoActivity.kt`](mobile/android/example/AbiDemoActivity.kt) (`AbiDemoActivity` / `previewScenarioPayload` + `confirmSubmit`) | [`mobile/android/AbiAnalytics.kt`](mobile/android/AbiAnalytics.kt) (`buildPendingBatchPayload`) | Khởi chạy `AbiDemoActivity` trên Android hoặc gọi `previewScenarioPayload` + `confirmSubmit` (xem [`mobile/android/README.en.md`](mobile/android/README.en.md)) |
| **SDK Máy khách iOS Swift** | [`mobile/ios/example/AbiDemoViewController.swift`](mobile/ios/example/AbiDemoViewController.swift) (`AbiSdkDemoView` / `AbiSdkDemoRunner`) | [`mobile/ios/AbiAnalytics.swift`](mobile/ios/AbiAnalytics.swift) (`buildPendingBatchJsonString`) | Gắn `AbiSdkDemoView()` trong SwiftUI hoặc kiểm tra kiểu: `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| **Bộ công cụ nhập dữ liệu LogBus 2** | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) (`--demo` xem trước & xác nhận 2 bước) | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) + cấu hình Filebeat / Logstash / Vector / DataX | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |
