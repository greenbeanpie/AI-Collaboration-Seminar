package cn.buwei.nativeapp.push

/** Fail closed on restore/validation errors; never treat a cached account as a valid session. */
internal suspend fun validatedPushAccount(
    expectedAccount: String,
    restore: suspend () -> Unit,
    currentAccount: () -> String?,
    validateSession: suspend () -> String,
): String? {
    restore()
    val owner = currentAccount() ?: return null
    if (owner != expectedAccount) return null
    val validated = validateSession()
    return if (validated == owner && currentAccount() == owner) owner else null
}
