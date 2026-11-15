// ============================================================================
// ABI C / C++17 数据采集 SDK (Header-Only, Zero External & STL-ABI Dependencies)
// 对标数数科技 ThinkingData C/C++ SDK、Unreal Engine / Cocos2d-x SDK v3.4 规范
//
// 核心能力：
// 1. 零第三方依赖、跨编译器 ABI 兼容：单头文件即可集成至 Linux/macOS/Windows C/C++ 服务端
//    以及 Unreal Engine 4/5、Cocos2d-x 3.x/4.x 游戏客户端工程（无 STL ABI 冲突）。
// 2. 双模式架构：
//    - 服务端无状态模式（AbiAnalytics）：每次调用显式传入 account_id (login_id) / distinct_id 与客户端 "#ip"。
//    - 游戏客户端有状态模式（enable_client_mode / identify / login / logout / time_event）：
//      自动管理设备访客标识 distinct_id 与登录账号标识 login_id（login 仅本地更新 login_id，不覆盖 distinct_id、不发送任何网络事件），自动采集注入设备环境预置属性。
// 3. 四大 Consumer：StagingConsumer（两步式预览与确认提交）、LoggerConsumer（本地 JSONL 落盘）、
//    BatchConsumer（缓冲批量上报）、DebugConsumer（同步 L4 强校验与 dry_run 预检）。
// 4. 严格契约保护：UTF-8 校验、控制字符拦截、64/128 字节身份边界、> 2^53-1 雪花大整数自动转字符串、
//    #time/$time 自动提取剥离、公共属性与 $user_* 画像事件严格隔离。
// 5. C 语言导出接口（extern "C"）：便于纯 C 宿主、FFI 或自定义引擎插件调用。
// ============================================================================

#ifndef ABI_SDK_HPP
#define ABI_SDK_HPP

#include <ctype.h>
#include <limits.h>
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if !defined(_WIN32)
#include <pthread.h>
#include <sys/time.h>
#include <unistd.h>
#endif

#if __has_include(<initializer_list>)
#include <initializer_list>
#else
namespace std {
template <class _Ep>
class initializer_list {
    const _Ep* __begin_;
    size_t __size_;
    constexpr initializer_list(const _Ep* __b, size_t __s) noexcept : __begin_(__b), __size_(__s) {}
public:
    constexpr initializer_list() noexcept : __begin_(nullptr), __size_(0) {}
    constexpr size_t size() const noexcept { return __size_; }
    constexpr const _Ep* begin() const noexcept { return __begin_; }
    constexpr const _Ep* end() const noexcept { return __begin_ + __size_; }
};
} // namespace std
#endif

namespace abi {

// ============================================================================
// 1. 协议常量与限制定义
// ============================================================================

constexpr size_t MAX_EVENT_ID_BYTES     = 64;
constexpr size_t MAX_DISTINCT_ID_BYTES  = 64;
constexpr size_t MAX_LOGIN_ID_BYTES     = 128;
constexpr size_t MAX_EVENT_NAME_CHARS   = 128;
constexpr size_t MAX_CUSTOM_KEY_CHARS   = 64;
constexpr int64_t MAX_SAFE_INTEGER      = 9007199254740991LL; // 2^53 - 1 (IEEE-754 双精度最大安全整数)
constexpr const char* SDK_LIB_NAME      = "abi-cpp-sdk";
constexpr const char* SDK_LIB_VERSION   = "1.0.0";

// ============================================================================
// 2. 自包含跨引擎基础容器 (String / Vector / Map / Error / Mutex)
//    避免 Unreal Engine / Cocos2d-x / 跨编译器 libc++ 与 libstdc++ 符号冲突
// ============================================================================

class String {
public:
    static constexpr size_t npos = static_cast<size_t>(-1);

    String() : data_(alloc_empty()), len_(0), cap_(0) {}

    String(const char* s) {
        if (!s || s[0] == '\0') {
            data_ = alloc_empty();
            len_  = 0;
            cap_  = 0;
        } else {
            init_from(s, ::strlen(s));
        }
    }

    String(const char* s, size_t n) {
        if (!s || n == 0) {
            data_ = alloc_empty();
            len_  = 0;
            cap_  = 0;
        } else {
            init_from(s, n);
        }
    }

    String(size_t count, char ch) {
        if (count == 0) {
            data_ = alloc_empty();
            len_  = 0;
            cap_  = 0;
        } else {
            cap_  = count;
            len_  = count;
            data_ = static_cast<char*>(::malloc(cap_ + 1));
            ::memset(data_, ch, count);
            data_[count] = '\0';
        }
    }

    String(const String& other) {
        if (other.len_ == 0) {
            data_ = alloc_empty();
            len_  = 0;
            cap_  = 0;
        } else {
            init_from(other.data_, other.len_);
        }
    }

    String(String&& other) noexcept : data_(other.data_), len_(other.len_), cap_(other.cap_) {
        other.data_ = alloc_empty();
        other.len_  = 0;
        other.cap_  = 0;
    }

    ~String() {
        free_buf();
    }

    String& operator=(const String& other) {
        if (this != &other) {
            free_buf();
            if (other.len_ == 0) {
                data_ = alloc_empty();
                len_  = 0;
                cap_  = 0;
            } else {
                init_from(other.data_, other.len_);
            }
        }
        return *this;
    }

    String& operator=(String&& other) noexcept {
        if (this != &other) {
            free_buf();
            data_       = other.data_;
            len_        = other.len_;
            cap_        = other.cap_;
            other.data_ = alloc_empty();
            other.len_  = 0;
            other.cap_  = 0;
        }
        return *this;
    }

    String& operator=(const char* s) {
        *this = String(s);
        return *this;
    }

    const char* c_str() const noexcept { return data_; }
    size_t size() const noexcept { return len_; }
    size_t length() const noexcept { return len_; }
    bool empty() const noexcept { return len_ == 0; }

    char operator[](size_t i) const noexcept { return data_[i]; }
    char& operator[](size_t i) noexcept { return data_[i]; }
    char back() const noexcept { return len_ > 0 ? data_[len_ - 1] : '\0'; }

    const char* begin() const noexcept { return data_; }
    const char* end() const noexcept { return data_ + len_; }

    void clear() noexcept {
        if (cap_ > 0 && data_) {
            data_[0] = '\0';
        }
        len_ = 0;
    }

    void reserve(size_t new_cap) {
        if (new_cap <= cap_) return;
        char* next = static_cast<char*>(::malloc(new_cap + 1));
        if (len_ > 0) {
            ::memcpy(next, data_, len_);
        }
        next[len_] = '\0';
        free_buf();
        data_ = next;
        cap_  = new_cap;
    }

    void push_back(char c) {
        if (len_ + 1 > cap_) {
            reserve(cap_ == 0 ? 16 : cap_ * 2);
        }
        data_[len_++] = c;
        data_[len_]   = '\0';
    }

    void pop_back() {
        if (len_ > 0) {
            data_[--len_] = '\0';
        }
    }

    String& append(const char* s, size_t n) {
        if (!s || n == 0) return *this;
        if (len_ + n > cap_) {
            size_t next_cap = (cap_ == 0) ? 16 : cap_;
            while (next_cap < len_ + n) next_cap *= 2;
            reserve(next_cap);
        }
        ::memcpy(data_ + len_, s, n);
        len_ += n;
        data_[len_] = '\0';
        return *this;
    }

    String& operator+=(const String& rhs) {
        return append(rhs.data_, rhs.len_);
    }

    String& operator+=(const char* rhs) {
        if (rhs) append(rhs, ::strlen(rhs));
        return *this;
    }

    String& operator+=(char c) {
        push_back(c);
        return *this;
    }

    String substr(size_t pos, size_t count = npos) const {
        if (pos >= len_) return String();
        size_t rem = len_ - pos;
        size_t n   = (count == npos || count > rem) ? rem : count;
        return String(data_ + pos, n);
    }

    size_t find(const String& needle, size_t pos = 0) const noexcept {
        if (pos > len_) return npos;
        if (needle.len_ == 0) return pos;
        if (needle.len_ > len_ - pos) return npos;
        for (size_t i = pos; i + needle.len_ <= len_; ++i) {
            if (::memcmp(data_ + i, needle.data_, needle.len_) == 0) {
                return i;
            }
        }
        return npos;
    }

    size_t find(const char* needle, size_t pos = 0) const noexcept {
        return find(String(needle), pos);
    }

    bool starts_with(const char* prefix) const noexcept {
        if (!prefix) return false;
        size_t plen = ::strlen(prefix);
        if (plen > len_) return false;
        return ::memcmp(data_, prefix, plen) == 0;
    }

    int compare(const String& other) const noexcept {
        size_t min_len = (len_ < other.len_) ? len_ : other.len_;
        int cmp        = (min_len > 0) ? ::memcmp(data_, other.data_, min_len) : 0;
        if (cmp != 0) return cmp;
        if (len_ < other.len_) return -1;
        if (len_ > other.len_) return 1;
        return 0;
    }

    bool operator==(const String& other) const noexcept {
        return len_ == other.len_ && (len_ == 0 || ::memcmp(data_, other.data_, len_) == 0);
    }
    bool operator!=(const String& other) const noexcept { return !(*this == other); }
    bool operator==(const char* s) const noexcept { return *this == String(s); }
    bool operator!=(const char* s) const noexcept { return !(*this == String(s)); }
    bool operator<(const String& other) const noexcept { return compare(other) < 0; }

private:
    static char* alloc_empty() noexcept {
        static char empty_ch = '\0';
        return &empty_ch;
    }

    void init_from(const char* s, size_t n) {
        cap_  = n;
        len_  = n;
        data_ = static_cast<char*>(::malloc(cap_ + 1));
        ::memcpy(data_, s, n);
        data_[n] = '\0';
    }

    void free_buf() noexcept {
        if (cap_ > 0 && data_) {
            ::free(data_);
        }
    }

    char* data_;
    size_t len_;
    size_t cap_;
};

inline String operator+(const String& lhs, const String& rhs) {
    String out;
    out.reserve(lhs.size() + rhs.size());
    out += lhs;
    out += rhs;
    return out;
}

inline String operator+(const String& lhs, const char* rhs) {
    return lhs + String(rhs);
}

inline String operator+(const char* lhs, const String& rhs) {
    return String(lhs) + rhs;
}

inline String int64_to_string(int64_t v) {
    char buf[32];
    ::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
    return String(buf);
}

inline String uint64_to_string(uint64_t v) {
    char buf[32];
    ::snprintf(buf, sizeof(buf), "%llu", static_cast<unsigned long long>(v));
    return String(buf);
}

/// SDK 异常类型
class Error {
public:
    explicit Error(const String& msg) : msg_(msg) {}
    explicit Error(const char* msg) : msg_(msg) {}
    const char* what() const noexcept { return msg_.c_str(); }
    const String& message() const noexcept { return msg_; }

private:
    String msg_;
};

/// 动态数组容器 Vector<T>
template <typename T>
class Vector {
public:
    Vector() : data_(nullptr), size_(0), cap_(0) {}

    Vector(std::initializer_list<T> init) : data_(nullptr), size_(0), cap_(0) {
        reserve(init.size());
        for (const auto& item : init) {
            push_back(item);
        }
    }

    Vector(const Vector& other) : data_(nullptr), size_(0), cap_(0) {
        reserve(other.size_);
        for (size_t i = 0; i < other.size_; ++i) {
            push_back(other.data_[i]);
        }
    }

    Vector(Vector&& other) noexcept : data_(other.data_), size_(other.size_), cap_(other.cap_) {
        other.data_ = nullptr;
        other.size_ = 0;
        other.cap_  = 0;
    }

    ~Vector() {
        delete[] data_;
    }

    Vector& operator=(const Vector& other) {
        if (this != &other) {
            delete[] data_;
            data_ = nullptr;
            size_ = 0;
            cap_  = 0;
            reserve(other.size_);
            for (size_t i = 0; i < other.size_; ++i) {
                push_back(other.data_[i]);
            }
        }
        return *this;
    }

    Vector& operator=(Vector&& other) noexcept {
        if (this != &other) {
            delete[] data_;
            data_       = other.data_;
            size_       = other.size_;
            cap_        = other.cap_;
            other.data_ = nullptr;
            other.size_ = 0;
            other.cap_  = 0;
        }
        return *this;
    }

    size_t size() const noexcept { return size_; }
    bool empty() const noexcept { return size_ == 0; }

    void clear() noexcept {
        size_ = 0;
    }

    void reserve(size_t new_cap) {
        if (new_cap <= cap_) return;
        T* next = new T[new_cap];
        for (size_t i = 0; i < size_; ++i) {
            next[i] = static_cast<T&&>(data_[i]);
        }
        delete[] data_;
        data_ = next;
        cap_  = new_cap;
    }

    void push_back(const T& val) {
        if (size_ + 1 > cap_) {
            reserve(cap_ == 0 ? 8 : cap_ * 2);
        }
        data_[size_++] = val;
    }

    void erase_first() {
        if (size_ == 0) return;
        for (size_t i = 1; i < size_; ++i) {
            data_[i - 1] = static_cast<T&&>(data_[i]);
        }
        --size_;
    }

    T& operator[](size_t i) noexcept { return data_[i]; }
    const T& operator[](size_t i) const noexcept { return data_[i]; }

    T* begin() noexcept { return data_; }
    T* end() noexcept { return data_ + size_; }
    const T* begin() const noexcept { return data_; }
    const T* end() const noexcept { return data_ + size_; }

private:
    T* data_;
    size_t size_;
    size_t cap_;
};

/// 有序键值映射容器 Map<K, V>（按键字典序升序排列，保证 JSON 预览字段顺序确定性）
template <typename K, typename V>
class Map {
public:
    struct Entry {
        K first;
        V second;
    };

    Map() = default;

    Map(std::initializer_list<Entry> init) {
        for (const auto& item : init) {
            (*this)[item.first] = item.second;
        }
    }

    size_t size() const noexcept { return entries_.size(); }
    bool empty() const noexcept { return entries_.empty(); }
    void clear() noexcept { entries_.clear(); }

    Entry* begin() noexcept { return entries_.begin(); }
    Entry* end() noexcept { return entries_.end(); }
    const Entry* begin() const noexcept { return entries_.begin(); }
    const Entry* end() const noexcept { return entries_.end(); }

    Entry* find(const K& key) noexcept {
        for (size_t i = 0; i < entries_.size(); ++i) {
            if (entries_[i].first == key) return &entries_[i];
        }
        return entries_.end();
    }

    const Entry* find(const K& key) const noexcept {
        for (size_t i = 0; i < entries_.size(); ++i) {
            if (entries_[i].first == key) return &entries_[i];
        }
        return entries_.end();
    }

    bool contains(const K& key) const noexcept {
        return find(key) != end();
    }

    const V& at(const K& key) const {
        const Entry* it = find(key);
        if (it == end()) {
            throw Error("Map::at key not found");
        }
        return it->second;
    }

    V& operator[](const K& key) {
        for (size_t i = 0; i < entries_.size(); ++i) {
            if (entries_[i].first == key) {
                return entries_[i].second;
            }
            if (key < entries_[i].first) {
                entries_.push_back(Entry{key, V()});
                for (size_t j = entries_.size() - 1; j > i; --j) {
                    entries_[j] = entries_[j - 1];
                }
                entries_[i] = Entry{key, V()};
                return entries_[i].second;
            }
        }
        entries_.push_back(Entry{key, V()});
        return entries_[entries_.size() - 1].second;
    }

    void erase(const K& key) {
        for (size_t i = 0; i < entries_.size(); ++i) {
            if (entries_[i].first == key) {
                for (size_t j = i + 1; j < entries_.size(); ++j) {
                    entries_[j - 1] = entries_[j];
                }
                Vector<Entry> next;
                next.reserve(entries_.size() - 1);
                for (size_t j = 0; j + 1 < entries_.size(); ++j) {
                    next.push_back(entries_[j]);
                }
                entries_ = static_cast<Vector<Entry>&&>(next);
                return;
            }
        }
    }

private:
    Vector<Entry> entries_;
};

/// 跨平台互斥锁
class Mutex {
public:
    Mutex() {
#if !defined(_WIN32)
        pthread_mutex_init(&mu_, nullptr);
#endif
    }
    ~Mutex() {
#if !defined(_WIN32)
        pthread_mutex_destroy(&mu_);
#endif
    }
    void lock() {
#if !defined(_WIN32)
        pthread_mutex_lock(&mu_);
#endif
    }
    void unlock() {
#if !defined(_WIN32)
        pthread_mutex_unlock(&mu_);
#endif
    }

private:
#if !defined(_WIN32)
    pthread_mutex_t mu_;
#endif
};

class LockGuard {
public:
    explicit LockGuard(Mutex& m) : m_(m) { m_.lock(); }
    ~LockGuard() { m_.unlock(); }

private:
    Mutex& m_;
};

// ============================================================================
// 3. 属性值多态容器 (Value) 与属性字典 (PropertyMap)
// ============================================================================

class Value {
public:
    enum class Kind {
        Null,
        Bool,
        Int64,
        UInt64,
        Double,
        String,
        Array
    };

    using Array = Vector<Value>;

    Value() : kind_(Kind::Null), i64_(0) {}
    Value(decltype(nullptr)) : kind_(Kind::Null), i64_(0) {}
    Value(bool b) : kind_(Kind::Bool), b_(b) {}
    Value(int v) : kind_(Kind::Int64), i64_(static_cast<int64_t>(v)) {}
    Value(long v) : kind_(Kind::Int64), i64_(static_cast<int64_t>(v)) {}
    Value(long long v) : kind_(Kind::Int64), i64_(static_cast<int64_t>(v)) {}
    Value(unsigned int v) : kind_(Kind::UInt64), u64_(static_cast<uint64_t>(v)) {}
    Value(unsigned long v) : kind_(Kind::UInt64), u64_(static_cast<uint64_t>(v)) {}
    Value(unsigned long long v) : kind_(Kind::UInt64), u64_(static_cast<uint64_t>(v)) {}
    Value(float f) : kind_(Kind::Double), d_(static_cast<double>(f)) {}
    Value(double d) : kind_(Kind::Double), d_(d) {}
    Value(const char* s) {
        if (!s) {
            kind_ = Kind::Null;
            i64_  = 0;
        } else {
            kind_ = Kind::String;
            str_  = String(s);
        }
    }
    Value(const String& s) : kind_(Kind::String), str_(s) {}
    Value(const Array& arr) : kind_(Kind::Array), arr_(arr) {}

    static Value from_string_list(std::initializer_list<const char*> items) {
        Array arr;
        for (const char* s : items) {
            arr.push_back(Value(s));
        }
        return Value(arr);
    }

    static Value from_int64_list(std::initializer_list<int64_t> items) {
        Array arr;
        for (int64_t v : items) {
            arr.push_back(Value(v));
        }
        return Value(arr);
    }

    bool is_null() const noexcept { return kind_ == Kind::Null; }
    bool is_bool() const noexcept { return kind_ == Kind::Bool; }
    bool is_int64() const noexcept { return kind_ == Kind::Int64; }
    bool is_uint64() const noexcept { return kind_ == Kind::UInt64; }
    bool is_double() const noexcept { return kind_ == Kind::Double; }
    bool is_string() const noexcept { return kind_ == Kind::String; }
    bool is_array() const noexcept { return kind_ == Kind::Array; }

    bool is_numeric() const noexcept {
        return is_int64() || is_uint64() || is_double();
    }

    bool as_bool() const { return b_; }
    int64_t as_int64() const { return i64_; }
    uint64_t as_uint64() const { return u64_; }
    double as_double() const {
        if (is_double()) return d_;
        if (is_int64()) return static_cast<double>(i64_);
        if (is_uint64()) return static_cast<double>(u64_);
        throw Error("Value is not numeric");
    }
    const String& as_string() const { return str_; }
    const Array& as_array() const { return arr_; }

private:
    Kind kind_;
    union {
        bool b_;
        int64_t i64_;
        uint64_t u64_;
        double d_;
    };
    String str_;
    Array arr_;
};

using PropertyMap = Map<String, Value>;

// ============================================================================
// 4. 传输数据结构定义 (TrackEvent / TrackBatchPayload / GatewayEnvelope)
// ============================================================================

/// 单条上报事件结构（对应 POST /collect/api/v1/track/batch 中 events 数组元素）
struct TrackEvent {
    String event_id;
    String event_name;
    String distinct_id;
    String login_id;
    int64_t timestamp = 0;
    PropertyMap properties;
};

/// 批量上报请求体结构
struct TrackBatchPayload {
    int64_t project_id = 0;
    String project_token;
    bool debug = false;
    bool dry_run = false;
    Vector<TrackEvent> events;
};

/// Debug / DryRun 模式下单条事件的错误明细
struct TrackEventError {
    int index = 0;
    String event_id;
    String event_name;
    String reason;
};

/// 采集网关标准响应信封
struct GatewayEnvelope {
    int code = 200;
    String message = "success";
    String request_id;
    int accepted = 0;
    int rejected = 0;
    bool dry_run = false;
    Vector<TrackEventError> errors;
};

/// 完整自定义上报选项（支持指定幂等 event_id、事件时间戳 timestamp_ms）
struct TrackOptions {
    String event_id;
    String event_name;
    String account_id;
    String distinct_id;
    int64_t timestamp_ms = 0;
    PropertyMap properties;
};

/// 游戏客户端（Unreal Engine / Cocos2d-x）设备环境配置
struct ClientDeviceConfig {
    String distinct_id;                      // 初始设备访客 ID（为空时自动生成 UUIDv4 或读取本地持久化）
    String storage_file;                     // 可选本地持久化文件路径（持久化 distinct_id 与 login_id）
    String platform     = "UnrealEngine";    // 引擎或平台标识，如 "UnrealEngine" 或 "Cocos2d-x"
    String os           = "Windows";         // 操作系统，如 "Windows" / "iOS" / "Android" / "macOS"
    String os_version   = "11";              // 系统版本
    String app_version  = "1.0.0";           // 游戏客户端版本号
    String device_model = "PC-Desktop";      // 设备型号
    int64_t screen_width  = 1920;            // 屏幕宽度
    int64_t screen_height = 1080;            // 屏幕高度
};

// ============================================================================
// 5. UTF-8 解码、身份校验、属性清洗与 JSON 序列化工具
// ============================================================================

namespace detail {

inline int64_t current_unix_millis() {
#if !defined(_WIN32)
    struct timeval tv;
    ::gettimeofday(&tv, nullptr);
    return static_cast<int64_t>(tv.tv_sec) * 1000LL + static_cast<int64_t>(tv.tv_usec / 1000);
#else
    return static_cast<int64_t>(::time(nullptr)) * 1000LL;
#endif
}

/// 生成标准 RFC 4122 UUIDv4 字符串
inline String generate_uuid_v4() {
    static Mutex rng_mu;
    static uint64_t state0 = 0x853c49e6748fea9bULL ^ static_cast<uint64_t>(current_unix_millis());
    static uint64_t state1 = 0xda3e39cb94b95bdbULL ^ reinterpret_cast<uintptr_t>(&state0);

    auto next_u64 = [&]() -> uint64_t {
        uint64_t s1       = state0;
        const uint64_t s0 = state1;
        state0            = s0;
        s1 ^= s1 << 23;
        state1 = s1 ^ s0 ^ (s1 >> 18) ^ (s0 >> 5);
        return state1 + s0;
    };

    uint64_t a = 0, b = 0;
    {
        LockGuard lk(rng_mu);
        a = next_u64();
        b = next_u64();
    }
    uint8_t bytes[16];
    for (int i = 0; i < 8; ++i) {
        bytes[i]     = static_cast<uint8_t>((a >> (i * 8)) & 0xFF);
        bytes[i + 8] = static_cast<uint8_t>((b >> (i * 8)) & 0xFF);
    }
    bytes[6] = (bytes[6] & 0x0F) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3F) | 0x80; // variant 10xx

    char buf[37];
    ::snprintf(
        buf, sizeof(buf),
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    );
    return String(buf);
}

/// 判断 Unicode 码点是否为空白字符（对齐 Go unicode.IsSpace + U+0085/U+00A0/U+2007/U+202F）
inline bool is_unicode_whitespace(uint32_t cp) {
    if (cp == 0x09 || cp == 0x0A || cp == 0x0B || cp == 0x0C || cp == 0x0D || cp == 0x20) {
        return true;
    }
    if (cp == 0x0085 || cp == 0x00A0 || cp == 0x1680) {
        return true;
    }
    if (cp >= 0x2000 && cp <= 0x200A) {
        return true;
    }
    if (cp == 0x2028 || cp == 0x2029 || cp == 0x202F || cp == 0x205F || cp == 0x3000) {
        return true;
    }
    return false;
}

/// 判断 Unicode 码点是否为禁止出现的 ASCII 控制字符（0x00-0x08, 0x0E-0x1F, 0x7F）
inline bool is_forbidden_control_char(uint32_t cp) {
    if (cp < 0x20 && (cp < 0x09 || cp > 0x0D)) {
        return true;
    }
    return cp == 0x7F;
}

struct CodepointSpan {
    uint32_t cp;
    size_t start;
    size_t length;
};

/// 严格校验并解码 UTF-8 字符串为码点序列
inline bool decode_utf8(const String& s, Vector<CodepointSpan>& out) {
    out.clear();
    size_t i = 0;
    const size_t n = s.size();
    while (i < n) {
        uint8_t b0 = static_cast<uint8_t>(s[i]);
        if (b0 < 0x80) {
            out.push_back({b0, i, 1});
            i += 1;
        } else if ((b0 & 0xE0) == 0xC0) {
            if (i + 1 >= n) return false;
            uint8_t b1 = static_cast<uint8_t>(s[i + 1]);
            if ((b1 & 0xC0) != 0x80) return false;
            uint32_t cp = ((b0 & 0x1F) << 6) | (b1 & 0x3F);
            if (cp < 0x80) return false; // 拒绝过长编码
            out.push_back({cp, i, 2});
            i += 2;
        } else if ((b0 & 0xF0) == 0xE0) {
            if (i + 2 >= n) return false;
            uint8_t b1 = static_cast<uint8_t>(s[i + 1]);
            uint8_t b2 = static_cast<uint8_t>(s[i + 2]);
            if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80) return false;
            uint32_t cp = ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
            if (cp < 0x800) return false;
            if (cp >= 0xD800 && cp <= 0xDFFF) return false; // 拒绝 UTF-16 代理项
            out.push_back({cp, i, 3});
            i += 3;
        } else if ((b0 & 0xF8) == 0xF0) {
            if (i + 3 >= n) return false;
            uint8_t b1 = static_cast<uint8_t>(s[i + 1]);
            uint8_t b2 = static_cast<uint8_t>(s[i + 2]);
            uint8_t b3 = static_cast<uint8_t>(s[i + 3]);
            if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80 || (b3 & 0xC0) != 0x80) return false;
            uint32_t cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
            if (cp < 0x10000 || cp > 0x10FFFF) return false;
            out.push_back({cp, i, 4});
            i += 4;
        } else {
            return false;
        }
    }
    return true;
}

inline String trim_ascii(const String& s) {
    size_t start = 0;
    while (start < s.size() && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r')) {
        ++start;
    }
    size_t end = s.size();
    while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t' || s[end - 1] == '\n' || s[end - 1] == '\r')) {
        --end;
    }
    return s.substr(start, end - start);
}

inline bool is_valid_identifier(const String& s) {
    if (s.empty()) return false;
    char c0 = s[0];
    if (!((c0 >= 'A' && c0 <= 'Z') || (c0 >= 'a' && c0 <= 'z') || c0 == '_')) {
        return false;
    }
    for (size_t i = 1; i < s.size(); ++i) {
        char c = s[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) {
            return false;
        }
    }
    return true;
}

inline bool is_system_event_whitelisted(const String& s) {
    static const char* const kList[] = {
        "$signup", "$login", "$pageview",
        "$AppStart", "$AppEnd", "$AppClick", "$AppViewScreen",
        "$user_set", "#user_set",
        "$user_set_once", "#user_set_once",
        "$user_add", "#user_add",
        "$user_unset", "#user_unset",
        "$user_append", "#user_append",
        "$user_uniq_append", "#user_uniq_append",
        "$user_del", "#user_del"
    };
    for (const char* item : kList) {
        if (s == item) return true;
    }
    return false;
}

inline bool is_system_property_whitelisted(const String& s) {
    static const char* const kList[] = {
        "$os", "#os", "os",
        "$os_version", "#os_version", "os_version",
        "$app_version", "#app_version", "app_version",
        "$browser", "#browser", "browser",
        "$browser_version", "#browser_version", "browser_version",
        "$city", "#city", "city",
        "$province", "#province", "province",
        "$country", "#country", "country",
        "$country_code", "#country_code", "country_code",
        "$ip", "#ip", "ip",
        "$network", "#network", "network",
        "$network_type", "#network_type", "network_type",
        "$platform", "#platform", "platform",
        "$device_id", "#device_id", "device_id",
        "$session_id", "#session_id", "session_id",
        "$screen_width", "#screen_width", "screen_width",
        "$screen_height", "#screen_height", "screen_height",
        "$model", "#model", "model",
        "$device_model", "#device_model", "device_model",
        "$manufacturer", "#manufacturer", "manufacturer",
        "$carrier", "#carrier", "carrier",
        "$url", "#url", "url",
        "$url_path", "#url_path", "url_path",
        "$referrer", "#referrer", "referrer",
        "$title", "#title", "title",
        "$duration", "#duration", "duration",
        "$lib", "#lib", "lib",
        "$lib_version", "#lib_version", "lib_version",
        "$zone_offset", "#zone_offset", "zone_offset",
        "$first_check_id", "#first_check_id", "first_check_id"
    };
    for (const char* item : kList) {
        if (s == item) return true;
    }
    return false;
}

/// 解析时间字符串（支持 "YYYY-MM-DD HH:MM:SS[.fff]" 及 ISO-8601 "YYYY-MM-DDTHH:MM:SS[.fff][Z|+HH:MM]"）为毫秒时间戳
inline bool parse_datetime_string_ms(const String& raw, int64_t& out_ms) {
    String s = trim_ascii(raw);
    if (s.size() < 19) return false;

    int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
    char sepT = s[10];
    if (s[4] != '-' || s[7] != '-' || (sepT != 'T' && sepT != ' ' && sepT != 't') || s[13] != ':' || s[16] != ':') {
        return false;
    }
    if (::sscanf(s.c_str(), "%4d-%2d-%2d%*c%2d:%2d:%2d", &year, &month, &day, &hour, &minute, &second) != 6) {
        return false;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 60) {
        return false;
    }

    size_t pos = 19;
    int millis = 0;
    if (pos < s.size() && s[pos] == '.') {
        ++pos;
        int digits = 0;
        int frac   = 0;
        while (pos < s.size() && s[pos] >= '0' && s[pos] <= '9') {
            if (digits < 3) {
                frac = frac * 10 + (s[pos] - '0');
                ++digits;
            }
            ++pos;
        }
        while (digits > 0 && digits < 3) {
            frac *= 10;
            ++digits;
        }
        millis = frac;
    }

    bool has_tz = false;
    int tz_offset_seconds = 0;
    if (pos < s.size()) {
        if (s[pos] == 'Z' || s[pos] == 'z') {
            has_tz            = true;
            tz_offset_seconds = 0;
            ++pos;
        } else if (s[pos] == '+' || s[pos] == '-') {
            has_tz   = true;
            int sign = (s[pos] == '-') ? -1 : 1;
            ++pos;
            if (pos + 2 > s.size()) return false;
            int tz_h = (s[pos] - '0') * 10 + (s[pos + 1] - '0');
            pos += 2;
            int tz_m = 0;
            if (pos < s.size() && s[pos] == ':') ++pos;
            if (pos + 2 <= s.size()) {
                tz_m = (s[pos] - '0') * 10 + (s[pos + 1] - '0');
                pos += 2;
            }
            tz_offset_seconds = sign * (tz_h * 3600 + tz_m * 60);
        }
    }
    if (pos != s.size()) {
        return false;
    }

    struct tm tm_val;
    ::memset(&tm_val, 0, sizeof(tm_val));
    tm_val.tm_year  = year - 1900;
    tm_val.tm_mon   = month - 1;
    tm_val.tm_mday  = day;
    tm_val.tm_hour  = hour;
    tm_val.tm_min   = minute;
    tm_val.tm_sec   = second;
    tm_val.tm_isdst = -1;

    time_t epoch_sec = 0;
    if (has_tz) {
#if defined(_WIN32)
        epoch_sec = _mkgmtime(&tm_val);
#else
        epoch_sec = ::timegm(&tm_val);
#endif
        epoch_sec -= tz_offset_seconds;
    } else {
        epoch_sec = ::mktime(&tm_val);
    }
    if (epoch_sec < 0) return false;
    out_ms = static_cast<int64_t>(epoch_sec) * 1000LL + millis;
    return true;
}

/// JSON 字符串转义辅助函数
inline String escape_json_string(const String& s) {
    String out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[7];
                    ::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
                break;
        }
    }
    out.push_back('"');
    return out;
}

inline String format_double_json(double d) {
    char buf[64];
    ::snprintf(buf, sizeof(buf), "%.15g", d);
    return String(buf);
}

inline String serialize_value_json(const Value& v, int indent_level, bool pretty) {
    if (v.is_null()) return "null";
    if (v.is_bool()) return v.as_bool() ? "true" : "false";
    if (v.is_int64()) return int64_to_string(v.as_int64());
    if (v.is_uint64()) return uint64_to_string(v.as_uint64());
    if (v.is_double()) return format_double_json(v.as_double());
    if (v.is_string()) return escape_json_string(v.as_string());
    if (v.is_array()) {
        const auto& arr = v.as_array();
        if (arr.empty()) return "[]";
        String out = "[";
        String child_indent(pretty ? (indent_level + 1) * 2 : 0, ' ');
        String end_indent(pretty ? indent_level * 2 : 0, ' ');
        for (size_t i = 0; i < arr.size(); ++i) {
            if (pretty) out += String("\n") + child_indent;
            out += serialize_value_json(arr[i], indent_level + 1, pretty);
            if (i + 1 < arr.size()) out += ",";
        }
        if (pretty) out += String("\n") + end_indent;
        out += "]";
        return out;
    }
    return "null";
}

inline String serialize_event_json(const TrackEvent& evt, int indent_level, bool pretty) {
    String ind0(pretty ? indent_level * 2 : 0, ' ');
    String ind1(pretty ? (indent_level + 1) * 2 : 0, ' ');
    String ind2(pretty ? (indent_level + 2) * 2 : 0, ' ');
    String nl = pretty ? "\n" : "";
    String sp = pretty ? " " : "";

    String out = String("{") + nl;
    Vector<String> fields;
    if (!evt.event_id.empty()) {
        fields.push_back(ind1 + "\"event_id\":" + sp + escape_json_string(evt.event_id));
    }
    fields.push_back(ind1 + "\"event_name\":" + sp + escape_json_string(evt.event_name));
    fields.push_back(ind1 + "\"distinct_id\":" + sp + escape_json_string(evt.distinct_id));
    if (!evt.login_id.empty()) {
        fields.push_back(ind1 + "\"login_id\":" + sp + escape_json_string(evt.login_id));
    }
    fields.push_back(ind1 + "\"timestamp\":" + sp + int64_to_string(evt.timestamp));

    if (evt.properties.empty()) {
        fields.push_back(ind1 + "\"properties\":" + sp + "{}");
    } else {
        String props_str = String("{") + nl;
        size_t idx = 0;
        for (const auto& kv : evt.properties) {
            props_str += ind2 + escape_json_string(kv.first) + ":" + sp +
                         serialize_value_json(kv.second, indent_level + 2, pretty);
            if (++idx < evt.properties.size()) props_str += ",";
            props_str += nl;
        }
        props_str += ind1 + "}";
        fields.push_back(ind1 + "\"properties\":" + sp + props_str);
    }

    for (size_t i = 0; i < fields.size(); ++i) {
        out += fields[i];
        if (i + 1 < fields.size()) out += ",";
        out += nl;
    }
    out += ind0 + "}";
    return out;
}

inline String serialize_batch_payload_json(const TrackBatchPayload& payload, bool pretty) {
    String ind1(pretty ? 2 : 0, ' ');
    String nl = pretty ? "\n" : "";
    String sp = pretty ? " " : "";

    String out = String("{") + nl;
    out += ind1 + "\"project_id\":" + sp + int64_to_string(payload.project_id) + "," + nl;
    out += ind1 + "\"project_token\":" + sp + escape_json_string(payload.project_token) + "," + nl;
    if (payload.debug) {
        out += ind1 + "\"debug\":" + sp + "true," + nl;
    }
    if (payload.dry_run) {
        out += ind1 + "\"dry_run\":" + sp + "true," + nl;
    }
    if (payload.events.empty()) {
        out += ind1 + "\"events\":" + sp + "[]" + nl;
    } else {
        out += ind1 + "\"events\":" + sp + "[" + nl;
        for (size_t i = 0; i < payload.events.size(); ++i) {
            out += (pretty ? "    " : "") + serialize_event_json(payload.events[i], 2, pretty);
            if (i + 1 < payload.events.size()) out += ",";
            out += nl;
        }
        out += ind1 + "]" + nl;
    }
    out += "}";
    return out;
}

inline String serialize_envelope_json(const GatewayEnvelope& env, bool pretty = true) {
    String ind1(pretty ? 2 : 0, ' ');
    String ind2(pretty ? 4 : 0, ' ');
    String nl = pretty ? "\n" : "";
    String sp = pretty ? " " : "";

    String out = String("{") + nl;
    out += ind1 + "\"code\":" + sp + int64_to_string(env.code) + "," + nl;
    out += ind1 + "\"message\":" + sp + escape_json_string(env.message) + "," + nl;
    out += ind1 + "\"request_id\":" + sp + escape_json_string(env.request_id) + "," + nl;
    out += ind1 + "\"data\":" + sp + "{" + nl;
    out += ind2 + "\"accepted\":" + sp + int64_to_string(env.accepted) + "," + nl;
    out += ind2 + "\"rejected\":" + sp + int64_to_string(env.rejected) + "," + nl;
    out += ind2 + "\"dry_run\":" + sp + (env.dry_run ? "true" : "false") + nl;
    out += ind1 + "}" + nl;
    out += "}";
    return out;
}

} // namespace detail

// ============================================================================
// 6. 公共校验与规范化函数
// ============================================================================

/// 规范化并校验身份标识（检查 UTF-8、拦截控制字符、裁剪首尾 Unicode 空白符、校验 UTF-8 字节上限）
inline String normalize_identity(const String& val, size_t max_utf8_bytes) {
    Vector<detail::CodepointSpan> spans;
    if (!detail::decode_utf8(val, spans)) {
        throw Error("identity is not valid UTF-8");
    }
    for (const auto& sp : spans) {
        if (detail::is_forbidden_control_char(sp.cp)) {
            char buf[64];
            ::snprintf(buf, sizeof(buf), "identity contains control character U+%04X", sp.cp);
            throw Error(buf);
        }
    }
    size_t first = 0;
    while (first < spans.size() && detail::is_unicode_whitespace(spans[first].cp)) {
        ++first;
    }
    size_t last = spans.size();
    while (last > first && detail::is_unicode_whitespace(spans[last - 1].cp)) {
        --last;
    }
    String trimmed;
    if (first < last) {
        size_t byte_start = spans[first].start;
        size_t byte_end   = spans[last - 1].start + spans[last - 1].length;
        trimmed = val.substr(byte_start, byte_end - byte_start);
    }
    if (trimmed.size() > max_utf8_bytes) {
        throw Error(
            String("identity exceeds max length of ") + int64_to_string(static_cast<int64_t>(max_utf8_bytes)) +
            " UTF-8 bytes (got " + int64_to_string(static_cast<int64_t>(trimmed.size())) + ")"
        );
    }
    return trimmed;
}

/// 联合校验并规范化双身份字段（distinct_id <= 64 UTF-8 字节，login_id <= 128 UTF-8 字节，且至少一个非空）
inline void normalize_identity_pair(
    const String& distinct_id,
    const String& login_id,
    String& out_distinct_id,
    String& out_login_id
) {
    out_distinct_id = normalize_identity(distinct_id, MAX_DISTINCT_ID_BYTES);
    out_login_id    = normalize_identity(login_id, MAX_LOGIN_ID_BYTES);
    if (out_distinct_id.empty() && out_login_id.empty()) {
        throw Error("at least one of login_id (account_id) or distinct_id must be non-empty");
    }
}

/// 校验事件名（符合 ^[A-Za-z_][A-Za-z0-9_]*$ 或系统预置事件白名单，上限 128 字符）
inline String validate_event_name(const String& name) {
    String trimmed = detail::trim_ascii(name);
    if (trimmed.empty()) {
        throw Error("event_name must not be empty");
    }
    if (trimmed.size() > MAX_EVENT_NAME_CHARS) {
        throw Error("event_name exceeds 128 characters");
    }
    if (detail::is_system_event_whitelisted(trimmed)) {
        return trimmed;
    }
    if (!detail::is_valid_identifier(trimmed)) {
        throw Error(String("invalid event_name \"") + trimmed + "\": must match ^[A-Za-z_][A-Za-z0-9_]*$");
    }
    return trimmed;
}

/// 校验属性键名（符合 ^[A-Za-z_][A-Za-z0-9_]*$ 或系统预置属性白名单，上限 64 字符）
inline String validate_property_key(const String& key) {
    String trimmed = detail::trim_ascii(key);
    if (trimmed.empty()) {
        throw Error("property key must not be empty");
    }
    if (detail::is_system_property_whitelisted(trimmed)) {
        return trimmed;
    }
    if (trimmed.size() > MAX_CUSTOM_KEY_CHARS || !detail::is_valid_identifier(trimmed)) {
        throw Error(String("invalid property key \"") + trimmed + "\": must match ^[A-Za-z_][A-Za-z0-9_]*$ (max 64 chars)");
    }
    return trimmed;
}

namespace detail {

inline Value normalize_signed_int(int64_t v) {
    if (v == INT64_MIN || v > MAX_SAFE_INTEGER || v < -MAX_SAFE_INTEGER) {
        return Value(int64_to_string(v));
    }
    return Value(v);
}

inline Value normalize_unsigned_int(uint64_t v) {
    if (v > static_cast<uint64_t>(MAX_SAFE_INTEGER)) {
        return Value(uint64_to_string(v));
    }
    return Value(static_cast<int64_t>(v));
}

inline Value sanitize_list_element(const String& key, const Value& elem) {
    if (elem.is_null()) {
        throw Error(String("property \"") + key + "\" list contains null element");
    }
    if (elem.is_array()) {
        throw Error(String("property \"") + key + "\" list cannot contain nested array");
    }
    if (elem.is_bool() || elem.is_string()) {
        return elem;
    }
    if (elem.is_int64()) {
        return normalize_signed_int(elem.as_int64());
    }
    if (elem.is_uint64()) {
        return normalize_unsigned_int(elem.as_uint64());
    }
    if (elem.is_double()) {
        double d = elem.as_double();
        if (isnan(d) || isinf(d)) {
            throw Error(String("property \"") + key + "\" list contains non-finite float");
        }
        return Value(d);
    }
    throw Error(String("property \"") + key + "\" list contains unsupported element");
}

inline Value sanitize_property_value(const String& key, const Value& val) {
    if (val.is_bool() || val.is_string()) {
        return val;
    }
    if (val.is_int64()) {
        return normalize_signed_int(val.as_int64());
    }
    if (val.is_uint64()) {
        return normalize_unsigned_int(val.as_uint64());
    }
    if (val.is_double()) {
        double d = val.as_double();
        if (isnan(d) || isinf(d)) {
            throw Error(String("property \"") + key + "\" has non-finite float value");
        }
        return Value(d);
    }
    if (val.is_array()) {
        const auto& raw_arr = val.as_array();
        Value::Array clean_arr;
        clean_arr.reserve(raw_arr.size());
        for (const auto& elem : raw_arr) {
            clean_arr.push_back(sanitize_list_element(key, elem));
        }
        return Value(clean_arr);
    }
    throw Error(String("property \"") + key + "\" has unsupported value");
}

inline int64_t parse_event_time_value(const String& key, const Value& raw) {
    if (raw.is_int64() || raw.is_uint64()) {
        int64_t ts = raw.is_int64() ? raw.as_int64() : static_cast<int64_t>(raw.as_uint64());
        if (ts <= 0) {
            throw Error(String("invalid ") + key + " property: unix timestamp must be positive");
        }
        // >= 100,000,000,000 视为毫秒，否则视为秒并乘以 1000
        return (ts >= 100000000000LL) ? ts : (ts * 1000LL);
    }
    if (raw.is_string()) {
        int64_t ms = 0;
        if (!parse_datetime_string_ms(raw.as_string(), ms)) {
            throw Error(String("invalid ") + key + " property string: \"" + raw.as_string() + "\"");
        }
        return ms;
    }
    throw Error(String("invalid ") + key + " property: unsupported value type");
}

inline PropertyMap extract_event_time_and_strip(const PropertyMap& props, int64_t explicit_ts_ms, int64_t& resolved_ts_ms) {
    resolved_ts_ms = explicit_ts_ms;
    bool has_hash_time = false;
    Value hash_time_val;
    bool has_dollar_time = false;
    Value dollar_time_val;

    PropertyMap stripped;
    for (const auto& kv : props) {
        String trimmed = trim_ascii(kv.first);
        if (trimmed == "#time") {
            has_hash_time = true;
            hash_time_val = kv.second;
        } else if (trimmed == "$time") {
            has_dollar_time = true;
            dollar_time_val = kv.second;
        } else {
            stripped[kv.first] = kv.second;
        }
    }

    if (explicit_ts_ms > 0) {
        return stripped;
    }

    if (has_dollar_time) {
        resolved_ts_ms = parse_event_time_value("$time", dollar_time_val);
    }
    if (has_hash_time) {
        resolved_ts_ms = parse_event_time_value("#time", hash_time_val);
    }
    return stripped;
}

} // namespace detail

/// 清洗并校验属性字典（将超过 2^53-1 的 int64_t/uint64_t 自动转为字符串，过滤 null，拦截 NaN/Inf）
inline PropertyMap sanitize_properties(const PropertyMap& props) {
    PropertyMap out;
    for (const auto& kv : props) {
        String key = validate_property_key(kv.first);
        if (kv.second.is_null()) {
            continue;
        }
        out[key] = detail::sanitize_property_value(key, kv.second);
    }
    return out;
}

// ============================================================================
// 7. 四大 Consumer 接口与实现 (Staging / Logger / Batch / Debug)
// ============================================================================

class Consumer {
public:
    virtual ~Consumer() = default;
    virtual void add(const TrackEvent& event) = 0;
    virtual void flush() = 0;
    virtual void close() = 0;
};

using HttpTransportFunc = GatewayEnvelope (*)(const String& url, const String& body_json, bool debug, bool dry_run);

namespace detail {

inline GatewayEnvelope default_mock_gateway_transport(const TrackBatchPayload& payload) {
    static Mutex seq_mu;
    static int64_t seq = 0;
    int64_t cur_seq = 0;
    {
        LockGuard lk(seq_mu);
        cur_seq = ++seq;
    }
    GatewayEnvelope env;
    env.code       = 200;
    env.message    = "success";
    env.request_id = String("req_cpp_sdk_") + int64_to_string(cur_seq);
    env.accepted   = static_cast<int>(payload.events.size());
    env.rejected   = 0;
    env.dry_run    = payload.dry_run;
    return env;
}

} // namespace detail

/// 1. StagingConsumer：两步式「预览请求 JSON -> 确认提交」内存暂存消费者
class StagingConsumer : public Consumer {
public:
    StagingConsumer(int64_t project_id, const String& project_token, bool dry_run = false)
        : project_id_(project_id),
          project_token_(detail::trim_ascii(project_token)),
          debug_(false),
          dry_run_(dry_run) {
        if (project_id_ <= 0) {
            throw Error("project_id must be positive");
        }
        if (project_token_.empty()) {
            throw Error("project_token must not be empty");
        }
    }

    void add(const TrackEvent& event) override {
        LockGuard lk(mu_);
        events_.push_back(event);
    }

    void flush() override {}
    void close() override {}

    void set_debug(bool debug) {
        LockGuard lk(mu_);
        debug_ = debug;
    }

    void set_dry_run(bool dry_run) {
        LockGuard lk(mu_);
        dry_run_ = dry_run;
    }

    void reset() {
        LockGuard lk(mu_);
        events_.clear();
    }

    Vector<TrackEvent> events() const {
        LockGuard lk(mu_);
        return events_;
    }

    TrackBatchPayload build_request_payload() const {
        LockGuard lk(mu_);
        TrackBatchPayload p;
        p.project_id    = project_id_;
        p.project_token = project_token_;
        p.debug         = debug_;
        p.dry_run       = dry_run_;
        p.events        = events_;
        return p;
    }

    /// 生成格式化缩进的 POST /collect/api/v1/track/batch 完整请求 JSON 预览字符串
    String preview_request_json(bool pretty = true) const {
        TrackBatchPayload payload = build_request_payload();
        return detail::serialize_batch_payload_json(payload, pretty);
    }

    /// 确认提交：将当前暂存的所有事件正式投递至目标 Consumer 并执行 flush()，随后清空暂存区
    void confirm_submit(Consumer& target) {
        if (&target == this) {
            throw Error("confirm_submit target cannot be the same StagingConsumer");
        }
        Vector<TrackEvent> snapshot;
        {
            LockGuard lk(mu_);
            snapshot = events_;
        }
        for (const auto& evt : snapshot) {
            target.add(evt);
        }
        target.flush();
        {
            LockGuard lk(mu_);
            events_.clear();
        }
    }

    /// 确认提交至网关并返回结构化响应信封与格式化 Response JSON
    GatewayEnvelope submit_to_gateway(
        const String& server_url = "http://127.0.0.1:8081",
        HttpTransportFunc transport = nullptr,
        String* out_response_json = nullptr
    ) {
        TrackBatchPayload payload = build_request_payload();
        if (payload.events.empty()) {
            throw Error("staging consumer has no pending events to submit");
        }
        String req_json = detail::serialize_batch_payload_json(payload, false);
        GatewayEnvelope env;
        if (transport) {
            String endpoint = server_url;
            if (!endpoint.empty() && endpoint.back() == '/') {
                endpoint.pop_back();
            }
            endpoint += "/collect/api/v1/track/batch";
            env = transport(endpoint, req_json, payload.debug, payload.dry_run);
        } else {
            env = detail::default_mock_gateway_transport(payload);
        }
        if (out_response_json) {
            *out_response_json = detail::serialize_envelope_json(env, true);
        }
        reset();
        return env;
    }

private:
    mutable Mutex mu_;
    int64_t project_id_;
    String project_token_;
    bool debug_;
    bool dry_run_;
    Vector<TrackEvent> events_;
};

/// 2. LoggerConsumer：本地 JSONL（Newline-delimited JSON）落盘消费者，配合 Filebeat / Vector 采集
class LoggerConsumer : public Consumer {
public:
    enum class RotateMode {
        Daily,
        Hourly
    };

    struct Config {
        String file_path;
        String directory       = "/tmp";
        String file_prefix     = "abi.log";
        RotateMode rotate_mode = RotateMode::Daily;
        size_t max_file_size_mb = 256;
    };

    explicit LoggerConsumer(const Config& cfg) : cfg_(cfg) {}

    explicit LoggerConsumer(const String& file_path) {
        cfg_.file_path = file_path;
    }

    void add(const TrackEvent& event) override {
        String compact = detail::serialize_event_json(event, 0, false);
        LockGuard lk(mu_);
        lines_.push_back(compact);
        String path = resolve_target_path();
        if (!path.empty()) {
            FILE* fp = ::fopen(path.c_str(), "ab");
            if (!fp) {
                throw Error(String("failed to open log file: ") + path);
            }
            ::fwrite(compact.c_str(), 1, compact.size(), fp);
            ::fwrite("\n", 1, 1, fp);
            ::fflush(fp);
            ::fclose(fp);
        }
    }

    void flush() override {}
    void close() override {}

    Vector<String> logged_lines() const {
        LockGuard lk(mu_);
        return lines_;
    }

private:
    String resolve_target_path() const {
        if (!cfg_.file_path.empty()) {
            return cfg_.file_path;
        }
        if (cfg_.directory.empty()) {
            return "";
        }
        time_t now = ::time(nullptr);
        struct tm tm_now;
#if defined(_WIN32)
        localtime_s(&tm_now, &now);
#else
        ::localtime_r(&now, &tm_now);
#endif
        char suffix[32];
        if (cfg_.rotate_mode == RotateMode::Hourly) {
            ::strftime(suffix, sizeof(suffix), "%Y-%m-%d-%H", &tm_now);
        } else {
            ::strftime(suffix, sizeof(suffix), "%Y-%m-%d", &tm_now);
        }
        return cfg_.directory + "/" + cfg_.file_prefix + "." + suffix;
    }

    mutable Mutex mu_;
    Config cfg_;
    Vector<String> lines_;
};

/// 3. BatchConsumer：生产高吞吐批量缓冲消费者
class BatchConsumer : public Consumer {
public:
    struct Config {
        String server_url      = "http://127.0.0.1:8081";
        int64_t project_id     = 1;
        String project_token   = "abi_tok_default";
        size_t batch_size      = 50;
        size_t max_cache_size  = 10000;
        HttpTransportFunc transport = nullptr;
    };

    explicit BatchConsumer(const Config& cfg) : cfg_(cfg) {
        if (cfg_.project_id <= 0) {
            throw Error("BatchConsumer project_id must be positive");
        }
        if (detail::trim_ascii(cfg_.project_token).empty()) {
            throw Error("BatchConsumer project_token must not be empty");
        }
        if (cfg_.batch_size == 0) {
            cfg_.batch_size = 50;
        }
    }

    void add(const TrackEvent& event) override {
        bool should_flush = false;
        {
            LockGuard lk(mu_);
            if (buffer_.size() >= cfg_.max_cache_size) {
                buffer_.erase_first();
            }
            buffer_.push_back(event);
            should_flush = (buffer_.size() >= cfg_.batch_size);
        }
        if (should_flush) {
            flush();
        }
    }

    void flush() override {
        Vector<TrackEvent> batch;
        {
            LockGuard lk(mu_);
            if (buffer_.empty()) return;
            batch = buffer_;
            buffer_.clear();
        }
        TrackBatchPayload payload;
        payload.project_id    = cfg_.project_id;
        payload.project_token = cfg_.project_token;
        payload.debug         = false;
        payload.dry_run       = false;
        payload.events        = batch;

        String req_json = detail::serialize_batch_payload_json(payload, false);
        GatewayEnvelope env;
        if (cfg_.transport) {
            String endpoint = cfg_.server_url;
            if (!endpoint.empty() && endpoint.back() == '/') endpoint.pop_back();
            endpoint += "/collect/api/v1/track/batch";
            env = cfg_.transport(endpoint, req_json, false, false);
        } else {
            env = detail::default_mock_gateway_transport(payload);
        }
        {
            LockGuard lk(mu_);
            flushed_batches_.push_back(payload);
            last_envelope_ = env;
        }
    }

    void close() override {
        flush();
    }

    size_t pending_count() const {
        LockGuard lk(mu_);
        return buffer_.size();
    }

    Vector<TrackBatchPayload> flushed_batches() const {
        LockGuard lk(mu_);
        return flushed_batches_;
    }

    GatewayEnvelope last_envelope() const {
        LockGuard lk(mu_);
        return last_envelope_;
    }

private:
    mutable Mutex mu_;
    Config cfg_;
    Vector<TrackEvent> buffer_;
    Vector<TrackBatchPayload> flushed_batches_;
    GatewayEnvelope last_envelope_;
};

/// 4. DebugConsumer：研发期同步 L4 强校验与 dry_run 演练消费者
class DebugConsumer : public Consumer {
public:
    struct Config {
        String server_url      = "http://127.0.0.1:8081";
        int64_t project_id     = 1;
        String project_token   = "abi_tok_default";
        bool dry_run           = true;
        HttpTransportFunc transport = nullptr;
    };

    explicit DebugConsumer(const Config& cfg) : cfg_(cfg) {
        if (cfg_.project_id <= 0) {
            throw Error("DebugConsumer project_id must be positive");
        }
        if (detail::trim_ascii(cfg_.project_token).empty()) {
            throw Error("DebugConsumer project_token must not be empty");
        }
    }

    void add(const TrackEvent& event) override {
        TrackBatchPayload payload;
        payload.project_id    = cfg_.project_id;
        payload.project_token = cfg_.project_token;
        payload.debug         = true;
        payload.dry_run       = cfg_.dry_run;
        payload.events.push_back(event);

        String req_json = detail::serialize_batch_payload_json(payload, false);
        GatewayEnvelope env;
        if (cfg_.transport) {
            String endpoint = cfg_.server_url;
            if (!endpoint.empty() && endpoint.back() == '/') endpoint.pop_back();
            endpoint += "/collect/api/v1/track/batch";
            env = cfg_.transport(endpoint, req_json, true, cfg_.dry_run);
        } else {
            env = detail::default_mock_gateway_transport(payload);
        }
        LockGuard lk(mu_);
        sent_payloads_.push_back(payload);
        last_envelope_ = env;
    }

    void flush() override {}
    void close() override {}

    Vector<TrackBatchPayload> sent_payloads() const {
        LockGuard lk(mu_);
        return sent_payloads_;
    }

    GatewayEnvelope last_envelope() const {
        LockGuard lk(mu_);
        return last_envelope_;
    }

private:
    mutable Mutex mu_;
    Config cfg_;
    Vector<TrackBatchPayload> sent_payloads_;
    GatewayEnvelope last_envelope_;
};

// ============================================================================
// 8. AbiAnalytics 核心客户端（同时支持服务端无状态模式 & Unreal/Cocos2d-x 客户端模式）
// ============================================================================

class AbiAnalytics {
public:
    using DynamicSuperPropertiesCallback = PropertyMap (*)();

    explicit AbiAnalytics(Consumer* consumer) : consumer_(consumer) {
        if (!consumer_) {
            throw Error("AbiAnalytics consumer must not be null");
        }
    }

    explicit AbiAnalytics(Consumer& consumer) : consumer_(&consumer) {}

    // ------------------------------------------------------------------------
    // 8.1 静态与动态公共属性管理（严格遵循：静态 < 动态 < 单次事件属性，且绝不注入 $user_*）
    // ------------------------------------------------------------------------

    void set_super_properties(const PropertyMap& props) {
        PropertyMap clean = sanitize_properties(props);
        LockGuard lk(mu_);
        for (const auto& kv : clean) {
            super_props_[kv.first] = kv.second;
        }
    }

    void unset_super_property(const String& key) {
        String trimmed = detail::trim_ascii(key);
        LockGuard lk(mu_);
        super_props_.erase(key);
        if (trimmed != key) {
            super_props_.erase(trimmed);
        }
    }

    PropertyMap get_super_properties() const {
        LockGuard lk(mu_);
        return super_props_;
    }

    void clear_super_properties() {
        LockGuard lk(mu_);
        super_props_.clear();
    }

    void set_dynamic_super_properties(DynamicSuperPropertiesCallback fn) {
        LockGuard lk(mu_);
        dynamic_super_fn_ = fn;
    }

    // ------------------------------------------------------------------------
    // 8.2 服务端无状态模式 API（每次调用显式传入 account_id 与 distinct_id）
    // ------------------------------------------------------------------------

    /// 记录标准行为事件（account_id 与 distinct_id 至少一个非空；服务端如需地域分析请在 properties 中传入 "#ip"）
    void track(
        const String& account_id,
        const String& distinct_id,
        const String& event_name,
        const PropertyMap& properties = {}
    ) {
        TrackOptions opts;
        opts.event_name  = event_name;
        opts.account_id  = account_id;
        opts.distinct_id = distinct_id;
        opts.properties  = properties;
        track_with_options(opts);
    }

    /// 保留方法签名，但在当前版本显式抛出 Error 且绝不入队伪造的普通 track 事件（D7① / G6 门禁）
    /// @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate)
    void track_first(
        const String& account_id,
        const String& distinct_id,
        const String& event_name,
        const String& first_check_id,
        const PropertyMap& properties = {}
    ) {
        (void)account_id;
        (void)distinct_id;
        (void)event_name;
        (void)first_check_id;
        (void)properties;
        throw Error("track_first is unsupported in current version (D7① / G6 gate); use track_with_options with deterministic event_id for same-day idempotency");
    }

    /// 保留方法签名，但在当前版本显式抛出 Error 且绝不入队伪造的普通 track 事件（D7① / G6 门禁）
    /// @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate)
    void track_update(
        const String& account_id,
        const String& distinct_id,
        const String& event_name,
        const String& event_id,
        const PropertyMap& properties = {}
    ) {
        (void)account_id;
        (void)distinct_id;
        (void)event_name;
        (void)event_id;
        (void)properties;
        throw Error("track_update is unsupported in current version (D7① / G6 gate); use track_with_options with deterministic event_id for same-day idempotency");
    }

    /// 保留方法签名，但在当前版本显式抛出 Error 且绝不入队伪造的普通 track 事件（D7① / G6 门禁）
    /// @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate)
    void track_overwrite(
        const String& account_id,
        const String& distinct_id,
        const String& event_name,
        const String& event_id,
        const PropertyMap& properties = {}
    ) {
        (void)account_id;
        (void)distinct_id;
        (void)event_name;
        (void)event_id;
        (void)properties;
        throw Error("track_overwrite is unsupported in current version (D7① / G6 gate); use track_with_options with deterministic event_id for same-day idempotency");
    }

    /// 完整自定义选项事件上报
    void track_with_options(const TrackOptions& opts) {
        TrackEvent evt = build_event(opts, true, false);
        consumer_->add(evt);
    }

    // ------------------------------------------------------------------------
    // 8.3 服务端 7 类用户画像操作（自动隔离静态/动态公共属性与设备环境预置属性）
    // ------------------------------------------------------------------------

    /// 1. $user_set：覆盖写入用户画像属性
    void user_set(const String& account_id, const String& distinct_id, const PropertyMap& properties) {
        send_user_event(account_id, distinct_id, "$user_set", properties);
    }

    /// 2. $user_set_once：仅当用户画像属性尚未设置时首次写入
    void user_set_once(const String& account_id, const String& distinct_id, const PropertyMap& properties) {
        send_user_event(account_id, distinct_id, "$user_set_once", properties);
    }

    /// 3. $user_add：数值型画像属性原子累加/扣减（非数值属性直接抛异常拦截）
    void user_add(const String& account_id, const String& distinct_id, const PropertyMap& properties) {
        validate_user_add_numeric(properties);
        send_user_event(account_id, distinct_id, "$user_add", properties);
    }

    /// 4. $user_unset：清空指定的用户画像属性键（属性值填充 0 占位）
    void user_unset(const String& account_id, const String& distinct_id, const Vector<String>& keys) {
        PropertyMap props;
        for (const auto& k : keys) {
            props[k] = Value(0);
        }
        send_user_event(account_id, distinct_id, "$user_unset", props);
    }

    /// 5. $user_append：向列表型画像属性末尾追加元素（不去重）
    void user_append(const String& account_id, const String& distinct_id, const PropertyMap& properties) {
        send_user_event(account_id, distinct_id, "$user_append", properties);
    }

    /// 6. $user_uniq_append：向列表型画像属性追加元素并自动集合去重
    void user_uniq_append(const String& account_id, const String& distinct_id, const PropertyMap& properties) {
        send_user_event(account_id, distinct_id, "$user_uniq_append", properties);
    }

    /// 7. $user_del：删除当前主体的用户画像记录
    void user_delete(const String& account_id, const String& distinct_id) {
        send_user_event(account_id, distinct_id, "$user_del", {});
    }

    // ------------------------------------------------------------------------
    // 8.4 Unreal Engine / Cocos2d-x 游戏客户端有状态设备模式 API
    // （客户端直连网关时无需传 #ip，由网关自动提取连接公网 IP；SDK 自动维护访客 distinct_id、账号 login_id 与环境预置属性）
    // ------------------------------------------------------------------------

    /// 开启游戏客户端有状态设备模式（自动生成/读取并持久化访客 distinct_id，缓存客户端设备预置属性）
    void enable_client_mode(const ClientDeviceConfig& cfg = ClientDeviceConfig{}) {
        String persisted_distinct;
        String persisted_login;
        if (!cfg.storage_file.empty()) {
            load_client_identity_file(cfg.storage_file, persisted_distinct, persisted_login);
        }

        String did = normalize_identity(cfg.distinct_id, MAX_DISTINCT_ID_BYTES);
        if (did.empty()) {
            did = !persisted_distinct.empty() ? persisted_distinct : detail::generate_uuid_v4();
        }
        did = normalize_identity(did, MAX_DISTINCT_ID_BYTES);

        PropertyMap preset;
        preset["$lib"]           = SDK_LIB_NAME;
        preset["$lib_version"]   = SDK_LIB_VERSION;
        if (!cfg.platform.empty())     preset["$platform"]      = cfg.platform;
        if (!cfg.os.empty())           preset["$os"]            = cfg.os;
        if (!cfg.os_version.empty())   preset["$os_version"]    = cfg.os_version;
        if (!cfg.app_version.empty())  preset["$app_version"]   = cfg.app_version;
        if (!cfg.device_model.empty()) preset["$device_model"]  = cfg.device_model;
        if (cfg.screen_width > 0)      preset["$screen_width"]  = cfg.screen_width;
        if (cfg.screen_height > 0)     preset["$screen_height"] = cfg.screen_height;
        PropertyMap clean_preset = sanitize_properties(preset);

        LockGuard lk(mu_);
        client_mode_enabled_ = true;
        client_storage_file_ = cfg.storage_file;
        client_distinct_id_  = did;
        if (client_login_id_.empty() && !persisted_login.empty()) {
            client_login_id_ = persisted_login;
        }
        client_preset_props_ = clean_preset;
        save_client_identity_unlocked();
    }

    /// 客户端自定义/修改设备访客标识 distinct_id（<= 64 UTF-8 字节，纯本地更新并持久化，不发送任何网络事件）
    void identify(const String& distinct_id) {
        String norm_did = normalize_identity(distinct_id, MAX_DISTINCT_ID_BYTES);
        if (norm_did.empty()) {
            throw Error("identify distinct_id must not be empty");
        }
        LockGuard lk(mu_);
        client_mode_enabled_ = true;
        client_distinct_id_  = norm_did;
        save_client_identity_unlocked();
    }

    /// 客户端玩家账号登录：仅在本地设置并持久化 login_id（<= 128 UTF-8 字节），绝不覆盖 distinct_id，也不发送任何网络事件
    void login(const String& account_id) {
        String norm_login = normalize_identity(account_id, MAX_LOGIN_ID_BYTES);
        if (norm_login.empty()) {
            throw Error("login account_id must not be empty");
        }
        LockGuard lk(mu_);
        if (client_distinct_id_.empty()) {
            client_distinct_id_ = detail::generate_uuid_v4();
        }
        client_mode_enabled_ = true;
        client_login_id_     = norm_login;
        save_client_identity_unlocked();
    }

    /// 客户端玩家退出登录：仅清空本地 login_id，保持 distinct_id 不变，不发送任何网络事件
    void logout() {
        LockGuard lk(mu_);
        client_login_id_.clear();
        save_client_identity_unlocked();
    }

    /// 获取当前客户端访客/设备标识 distinct_id
    String get_distinct_id() const {
        LockGuard lk(mu_);
        return client_distinct_id_;
    }

    /// 获取当前客户端已登录账号标识 login_id（未登录时为空字符串）
    String get_login_id() const {
        LockGuard lk(mu_);
        return client_login_id_;
    }

    /// 开启事件耗时秒表计时（在后续调用 client_track(event_name) 时自动计算并写入 $duration 秒数）
    void time_event(const String& event_name) {
        String valid_name = validate_event_name(event_name);
        LockGuard lk(mu_);
        event_timers_[valid_name] = detail::current_unix_millis();
    }

    /// 客户端有状态上报行为事件（自动携带设备 distinct_id、login_id 与设备环境预置属性）
    void client_track(const String& event_name, const PropertyMap& properties = {}) {
        TrackOptions opts = prepare_client_track_options(event_name, "", properties);
        consumer_->add(build_event(opts, true, true));
    }

    /// @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate)
    void client_track_first(
        const String& event_name,
        const String& first_check_id,
        const PropertyMap& properties = {}
    ) {
        (void)event_name;
        (void)first_check_id;
        (void)properties;
        throw Error("client_track_first is unsupported in current version (D7① / G6 gate); use client_track with deterministic event_id for same-day idempotency");
    }

    /// @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate)
    void client_track_update(
        const String& event_name,
        const String& event_id,
        const PropertyMap& properties = {}
    ) {
        (void)event_name;
        (void)event_id;
        (void)properties;
        throw Error("client_track_update is unsupported in current version (D7① / G6 gate); use client_track with deterministic event_id for same-day idempotency");
    }

    /// @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate)
    void client_track_overwrite(
        const String& event_name,
        const String& event_id,
        const PropertyMap& properties = {}
    ) {
        (void)event_name;
        (void)event_id;
        (void)properties;
        throw Error("client_track_overwrite is unsupported in current version (D7① / G6 gate); use client_track with deterministic event_id for same-day idempotency");
    }

    void client_user_set(const PropertyMap& properties) {
        send_client_user_event("$user_set", properties);
    }

    void client_user_set_once(const PropertyMap& properties) {
        send_client_user_event("$user_set_once", properties);
    }

    void client_user_add(const PropertyMap& properties) {
        validate_user_add_numeric(properties);
        send_client_user_event("$user_add", properties);
    }

    void client_user_unset(const Vector<String>& keys) {
        PropertyMap props;
        for (const auto& k : keys) {
            props[k] = Value(0);
        }
        send_client_user_event("$user_unset", props);
    }

    void client_user_append(const PropertyMap& properties) {
        send_client_user_event("$user_append", properties);
    }

    void client_user_uniq_append(const PropertyMap& properties) {
        send_client_user_event("$user_uniq_append", properties);
    }

    void client_user_delete() {
        send_client_user_event("$user_del", {});
    }

    void flush() {
        consumer_->flush();
    }

    void close() {
        consumer_->close();
    }

private:
    static void validate_user_add_numeric(const PropertyMap& properties) {
        for (const auto& kv : properties) {
            String trimmed = detail::trim_ascii(kv.first);
            if (trimmed == "#time" || trimmed == "$time") {
                continue;
            }
            if (!kv.second.is_numeric()) {
                throw Error(String("user_add property \"") + kv.first + "\" must be numeric");
            }
        }
    }

    static void load_client_identity_file(const String& path, String& out_distinct, String& out_login) {
        if (path.empty()) return;
        FILE* fp = ::fopen(path.c_str(), "rb");
        if (!fp) return;
        char line1[256] = {0};
        char line2[256] = {0};
        if (::fgets(line1, sizeof(line1), fp)) {
            String s1 = detail::trim_ascii(String(line1));
            if (s1.starts_with("distinct_id=")) {
                try {
                    out_distinct = normalize_identity(s1.substr(12), MAX_DISTINCT_ID_BYTES);
                } catch (...) {}
            }
        }
        if (::fgets(line2, sizeof(line2), fp)) {
            String s2 = detail::trim_ascii(String(line2));
            if (s2.starts_with("login_id=")) {
                try {
                    out_login = normalize_identity(s2.substr(9), MAX_LOGIN_ID_BYTES);
                } catch (...) {}
            }
        }
        ::fclose(fp);
    }

    void save_client_identity_unlocked() const {
        if (client_storage_file_.empty()) return;
        FILE* fp = ::fopen(client_storage_file_.c_str(), "wb");
        if (!fp) return;
        ::fprintf(fp, "distinct_id=%s\nlogin_id=%s\n", client_distinct_id_.c_str(), client_login_id_.c_str());
        ::fflush(fp);
        ::fclose(fp);
    }

    TrackOptions prepare_client_track_options(
        const String& event_name,
        const String& event_id,
        const PropertyMap& properties
    ) {
        String valid_name  = validate_event_name(event_name);
        PropertyMap merged = properties;

        String login_id;
        String distinct_id;
        int64_t start_ms = -1;
        {
            LockGuard lk(mu_);
            if (client_distinct_id_.empty()) {
                client_distinct_id_ = detail::generate_uuid_v4();
                save_client_identity_unlocked();
            }
            login_id    = client_login_id_;
            distinct_id = client_distinct_id_;
            auto* it    = event_timers_.find(valid_name);
            if (it != event_timers_.end()) {
                start_ms = it->second;
                event_timers_.erase(valid_name);
            }
        }

        if (start_ms > 0 && !merged.contains("$duration")) {
            int64_t now_ms     = detail::current_unix_millis();
            int64_t elapsed_ms = (now_ms > start_ms) ? (now_ms - start_ms) : 0;
            double duration_s  = ::round((static_cast<double>(elapsed_ms) / 1000.0) * 1000.0) / 1000.0;
            merged["$duration"] = Value(duration_s);
        }

        TrackOptions opts;
        opts.event_id    = event_id;
        opts.event_name  = valid_name;
        opts.account_id  = login_id;
        opts.distinct_id = distinct_id;
        opts.properties  = merged;
        return opts;
    }

    void send_client_user_event(const String& op_name, const PropertyMap& properties) {
        String login_id;
        String distinct_id;
        {
            LockGuard lk(mu_);
            if (client_distinct_id_.empty()) {
                client_distinct_id_ = detail::generate_uuid_v4();
                save_client_identity_unlocked();
            }
            login_id    = client_login_id_;
            distinct_id = client_distinct_id_;
        }
        send_user_event(login_id, distinct_id, op_name, properties);
    }

    void send_user_event(
        const String& account_id,
        const String& distinct_id,
        const String& op_event_name,
        const PropertyMap& properties
    ) {
        TrackOptions opts;
        opts.event_name  = op_event_name;
        opts.account_id  = account_id;
        opts.distinct_id = distinct_id;
        opts.properties  = properties;
        TrackEvent evt = build_event(opts, false, false);
        consumer_->add(evt);
    }

    TrackEvent build_event(const TrackOptions& opts, bool include_super_props, bool include_client_presets) {
        String event_name = validate_event_name(opts.event_name);
        String norm_distinct;
        String norm_login;
        normalize_identity_pair(opts.distinct_id, opts.account_id, norm_distinct, norm_login);

        String event_id = opts.event_id;
        if (!event_id.empty()) {
            event_id = normalize_identity(event_id, MAX_EVENT_ID_BYTES);
        }
        if (event_id.empty()) {
            event_id = detail::generate_uuid_v4();
        }

        int64_t resolved_ts_ms = 0;
        PropertyMap props_without_time = detail::extract_event_time_and_strip(
            opts.properties, opts.timestamp_ms, resolved_ts_ms
        );
        PropertyMap clean_props = sanitize_properties(props_without_time);

        PropertyMap final_props;
        bool is_user_event = event_name.starts_with("$user_") || event_name.starts_with("#user_");

        if (!is_user_event) {
            PropertyMap static_super;
            PropertyMap client_presets;
            DynamicSuperPropertiesCallback dyn_fn = nullptr;
            {
                LockGuard lk(mu_);
                if (include_client_presets && client_mode_enabled_) {
                    client_presets = client_preset_props_;
                }
                if (include_super_props) {
                    static_super = super_props_;
                    dyn_fn       = dynamic_super_fn_;
                }
            }
            for (const auto& kv : client_presets) {
                final_props[kv.first] = kv.second;
            }
            for (const auto& kv : static_super) {
                final_props[kv.first] = kv.second;
            }
            if (dyn_fn) {
                PropertyMap clean_dyn = sanitize_properties(dyn_fn());
                for (const auto& kv : clean_dyn) {
                    final_props[kv.first] = kv.second;
                }
            }
        }

        for (const auto& kv : clean_props) {
            final_props[kv.first] = kv.second;
        }

        if (resolved_ts_ms <= 0) {
            resolved_ts_ms = detail::current_unix_millis();
        }

        TrackEvent evt;
        evt.event_id    = event_id;
        evt.event_name  = event_name;
        evt.distinct_id = norm_distinct;
        evt.login_id    = norm_login;
        evt.timestamp   = resolved_ts_ms;
        evt.properties  = final_props;
        return evt;
    }

    Consumer* consumer_;
    mutable Mutex mu_;
    PropertyMap super_props_;
    DynamicSuperPropertiesCallback dynamic_super_fn_ = nullptr;

    bool client_mode_enabled_ = false;
    String client_storage_file_;
    String client_distinct_id_;
    String client_login_id_;
    PropertyMap client_preset_props_;
    Map<String, int64_t> event_timers_;
};

} // namespace abi

// ============================================================================
// 9. C 语言导出接口封装 (extern "C")
// 便于纯 C 工程、Unreal/Cocos2d-x C 插件或跨语言 FFI 直接调用
// ============================================================================

extern "C" {

typedef struct abi_props_t {
    abi::PropertyMap map;
} abi_props_t;

typedef struct abi_client_t {
    abi::StagingConsumer* staging = nullptr;
    abi::AbiAnalytics* sdk        = nullptr;
    abi::String last_preview_json;
    abi::String last_error;
} abi_client_t;

inline abi_props_t* abi_props_create() {
    return new abi_props_t();
}

inline void abi_props_destroy(abi_props_t* props) {
    delete props;
}

inline void abi_props_set_string(abi_props_t* props, const char* key, const char* val) {
    if (props && key && val) {
        props->map[key] = abi::Value(val);
    }
}

inline void abi_props_set_int64(abi_props_t* props, const char* key, int64_t val) {
    if (props && key) {
        props->map[key] = abi::Value(val);
    }
}

inline void abi_props_set_double(abi_props_t* props, const char* key, double val) {
    if (props && key) {
        props->map[key] = abi::Value(val);
    }
}

inline void abi_props_set_bool(abi_props_t* props, const char* key, int val) {
    if (props && key) {
        props->map[key] = abi::Value(val != 0);
    }
}

inline abi_client_t* abi_client_create_staging(int64_t project_id, const char* project_token, int dry_run) {
    try {
        auto* handle    = new abi_client_t();
        handle->staging = new abi::StagingConsumer(project_id, project_token ? project_token : "", dry_run != 0);
        handle->sdk     = new abi::AbiAnalytics(handle->staging);
        return handle;
    } catch (...) {
        return nullptr;
    }
}

inline void abi_client_destroy(abi_client_t* client) {
    if (!client) return;
    delete client->sdk;
    delete client->staging;
    delete client;
}

inline int abi_track(
    abi_client_t* client,
    const char* account_id,
    const char* distinct_id,
    const char* event_name,
    const abi_props_t* props
) {
    if (!client || !client->sdk || !event_name) return -1;
    try {
        abi::PropertyMap empty_map;
        client->sdk->track(
            account_id ? account_id : "",
            distinct_id ? distinct_id : "",
            event_name,
            props ? props->map : empty_map
        );
        return 0;
    } catch (const abi::Error& ex) {
        client->last_error = ex.message();
        return -1;
    }
}

inline int abi_user_set(
    abi_client_t* client,
    const char* account_id,
    const char* distinct_id,
    const abi_props_t* props
) {
    if (!client || !client->sdk || !props) return -1;
    try {
        client->sdk->user_set(
            account_id ? account_id : "",
            distinct_id ? distinct_id : "",
            props->map
        );
        return 0;
    } catch (const abi::Error& ex) {
        client->last_error = ex.message();
        return -1;
    }
}

inline const char* abi_staging_preview_json(abi_client_t* client) {
    if (!client || !client->staging) return "";
    try {
        client->last_preview_json = client->staging->preview_request_json(true);
        return client->last_preview_json.c_str();
    } catch (const abi::Error& ex) {
        client->last_error = ex.message();
        return "";
    }
}

inline const char* abi_client_last_error(const abi_client_t* client) {
    if (!client) return "";
    return client->last_error.c_str();
}

} // extern "C"

#endif // ABI_SDK_HPP
