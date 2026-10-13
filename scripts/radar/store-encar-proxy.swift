import Foundation
import Security
import Darwin

let service = "chestny-prigon-encar-proxy"
let account = "catalog-worker"
let host = "kr.decodo.com"
let port = 10001

func prompt(_ text: String) -> String {
    FileHandle.standardError.write(Data(text.utf8))
    return readLine() ?? ""
}

func hiddenPrompt(_ text: String) -> String? {
    var buffer = [CChar](repeating: 0, count: 4096)
    guard readpassphrase(text, &buffer, buffer.count, RPP_ECHO_OFF) != nil else {
        return nil
    }
    return String(cString: buffer)
}

let username = prompt("Decodo proxy username: ").trimmingCharacters(in: .whitespacesAndNewlines)
guard !username.isEmpty else {
    fputs("Username cannot be empty.\n", stderr)
    exit(2)
}

guard let password = hiddenPrompt("Decodo proxy password (input hidden): "), !password.isEmpty else {
    fputs("Password input was empty. Nothing was saved.\n", stderr)
    exit(2)
}

var components = URLComponents()
components.scheme = "http"
components.host = host
components.port = port
components.user = username
components.password = password
guard let proxyURL = components.url else {
    fputs("Could not construct proxy configuration. Nothing was saved.\n", stderr)
    exit(2)
}

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]
let data = Data(proxyURL.absoluteString.utf8)
let update: [String: Any] = [kSecValueData as String: data]
let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
if updateStatus == errSecItemNotFound {
    var add = query
    add[kSecValueData as String] = data
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        fputs("Could not store proxy credential in login Keychain (status \(addStatus)).\n", stderr)
        exit(1)
    }
} else if updateStatus != errSecSuccess {
    fputs("Could not update proxy credential in login Keychain (status \(updateStatus)).\n", stderr)
    exit(1)
}

print("Decodo proxy credential stored in login Keychain for the Chestny catalog worker.")
