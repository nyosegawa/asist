import Foundation
import EventKit
import CryptoKit

// One request per process. Calendar contents travel through stdin/stdout only, never argv or logs.
struct Failure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw Failure(message: message) }
let store = EKEventStore()
func authorization() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: fatalError("Unsupported Calendar authorization status")
    }
}
func account(_ calendar: EKCalendar) -> [String: Any] {
    ["id": calendar.calendarIdentifier, "title": calendar.title, "source": calendar.source.title,
     "writable": calendar.allowsContentModifications]
}
func status() -> [String: Any] {
    ["authorization": authorization(), "calendars": authorization() == "fullAccess" ? store.calendars(for: .event).map(account) : []]
}
func eventData(_ event: EKEvent) throws -> [String: Any] {
    guard let id = event.eventIdentifier else { try fail("予定の識別子を取得できません") }
    var data: [String: Any] = [
        "id": id, "calendarId": event.calendar.calendarIdentifier, "calendarTitle": event.calendar.title,
        "title": event.title ?? "", "start": event.startDate.timeIntervalSince1970 * 1000,
        "end": event.endDate.timeIntervalSince1970 * 1000, "allDay": event.isAllDay,
        "location": event.location ?? "", "notes": event.notes ?? "",
        "timeZone": event.timeZone?.identifier ?? TimeZone.current.identifier,
        "recurring": event.hasRecurrenceRules || event.isDetached,
        // Google can set an organizer even on personal events without invitees.
        "hasAttendees": event.hasAttendees,
        "writable": event.calendar.allowsContentModifications
    ]
    // Include modification time as well as the displayed fields: external edits invalidate approval.
    data["modified"] = event.lastModifiedDate?.timeIntervalSince1970 ?? 0
    let encoded = try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
    data.removeValue(forKey: "modified")
    data["revision"] = SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
    return data
}
func text(_ input: [String: Any], _ key: String) throws -> String {
    guard let value = input[key] as? String else { try fail("入力が不正です: \(key)") }
    return value
}
func date(_ input: [String: Any], _ key: String) throws -> Date {
    let value = try text(input, key)
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let result = format.date(from: value) { return result }
    format.formatOptions = [.withInternetDateTime]
    guard let result = format.date(from: value) else { try fail("日時が不正です: \(key)") }
    return result
}
func existing(_ input: [String: Any]) throws -> EKEvent {
    guard let event = store.event(withIdentifier: try text(input, "eventId")) else { try fail("予定が見つかりません。再検索してください") }
    return event
}
func writable(_ calendar: EKCalendar) throws {
    guard calendar.allowsContentModifications else { try fail("このカレンダーには書き込めません") }
}
func perform(_ input: [String: Any]) async throws -> Any {
    let operation = try text(input, "operation")
    if operation == "status" { return status() }
    if operation == "requestAccess" {
        _ = try await store.requestFullAccessToEvents()
        return status()
    }
    guard authorization() == "fullAccess" else { try fail("macOSのカレンダーへのフルアクセスを許可してください") }
    if operation == "search" {
        guard let ids = input["calendarIds"] as? [String], !ids.isEmpty else { try fail("表示するカレンダーを選んでください") }
        let calendars = try ids.map { id -> EKCalendar in
            guard let calendar = store.calendar(withIdentifier: id) else { try fail("選択したカレンダーが見つかりません。設定で選び直してください") }
            return calendar
        }
        let start = try date(input, "start"), end = try date(input, "end")
        guard end > start, end.timeIntervalSince(start) <= 366 * 86400 else { try fail("検索範囲が不正です") }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
        return try store.events(matching: predicate).filter { $0.startDate < end && $0.endDate > start }
            .sorted { $0.startDate < $1.startDate }.map(eventData)
    }
    if operation == "get" { return try eventData(existing(input)) }
    guard ["create", "update", "delete"].contains(operation) else { try fail("未対応の操作です") }
    let event: EKEvent
    if operation == "create" {
        guard let calendar = store.calendar(withIdentifier: try text(input, "calendarId")) else { try fail("保存先が見つかりません") }
        try writable(calendar)
        event = EKEvent(eventStore: store)
        event.calendar = calendar
    } else {
        event = try existing(input)
        try writable(event.calendar)
        guard !event.hasRecurrenceRules && !event.isDetached && !event.hasAttendees else {
            try fail("繰り返し予定と招待付き予定の変更・削除はmacOSのカレンダーで行ってください")
        }
        guard try text(input, "revision") == eventData(event)["revision"] as? String else { try fail("確認後に予定が変わりました。再検索して確認し直してください") }
    }
    if operation == "delete" {
        let before = try eventData(event)
        try store.remove(event, span: .thisEvent, commit: true)
        return before
    }
    guard let fields = input["event"] as? [String: Any] else { try fail("予定の入力がありません") }
    let start = try date(fields, "start"), end = try date(fields, "end")
    guard end > start, let allDay = fields["allDay"] as? Bool,
          let zone = TimeZone(identifier: try text(fields, "timeZone")) else { try fail("予定の日時が不正です") }
    let title = try text(fields, "title").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { try fail("件名を入力してください") }
    if allDay {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        guard calendar.startOfDay(for: start) == start && calendar.startOfDay(for: end) == end else { try fail("終日は0時を指定してください") }
    }
    event.title = title; event.startDate = start; event.endDate = end
    event.isAllDay = allDay; event.timeZone = zone
    event.location = try text(fields, "location"); event.notes = try text(fields, "notes")
    try store.save(event, span: .thisEvent, commit: true)
    return try eventData(event)
}

Task {
    do {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("JSONオブジェクトが必要です") }
        let result = try await perform(input)
        let output = try JSONSerialization.data(withJSONObject: ["ok": true, "data": result], options: [.sortedKeys])
        FileHandle.standardOutput.write(output)
        exit(0)
    } catch {
        // Do not emit EventKit errors, which may contain user data.
        let message = (error as? Failure)?.message ?? "EventKitの処理に失敗しました。カレンダーの権限と同期状態を確認してください"
        let output = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message])
        FileHandle.standardOutput.write(output)
        exit(0)
    }
}
RunLoop.main.run()
