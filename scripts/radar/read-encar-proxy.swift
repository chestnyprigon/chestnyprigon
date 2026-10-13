import Foundation
import Security

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "chestny-prigon-encar-proxy",
    kSecAttrAccount as String: "catalog-worker",
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
]

var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
guard status == errSecSuccess, let data = item as? Data, !data.isEmpty else {
    fputs("Chestny Encar proxy credential unavailable from macOS Keychain (status \(status)).\n", stderr)
    exit(1)
}

FileHandle.standardOutput.write(data)
