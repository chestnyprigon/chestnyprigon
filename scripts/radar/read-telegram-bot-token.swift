import Foundation
import Security

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "chestny-prigon-telegram-bot",
    kSecAttrAccount as String: "catalog-control",
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne
]

var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
guard status == errSecSuccess, let token = item as? Data, !token.isEmpty else {
    fputs("Telegram credential unavailable from macOS Keychain (status \(status))\n", stderr)
    exit(1)
}

FileHandle.standardOutput.write(token)
