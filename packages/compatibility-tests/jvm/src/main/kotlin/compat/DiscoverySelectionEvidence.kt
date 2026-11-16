package compat

import com.google.gson.JsonObject

/** ExploreShowViewModel.ExplorePaginationState excerpt from Android commit 32a87b2. */
internal data class ExplorePageRequest(
    val page: Int,
    internal val requestId: Long,
    internal val advancesNextPage: Boolean,
)

internal class ExplorePaginationState {
    private var requestSequence = 0L
    private var activeRequestId: Long? = null

    var nextPage = 1
        private set

    @Synchronized
    fun skipTo(page: Int): Boolean {
        if (page <= 0) return false
        activeRequestId = null
        nextPage = page
        return true
    }

    @Synchronized
    fun startNextPage(): ExplorePageRequest = startRequest(nextPage, advancesNextPage = true)

    @Synchronized
    fun isActive(request: ExplorePageRequest): Boolean = activeRequestId == request.requestId

    @Synchronized
    fun complete(request: ExplorePageRequest): Boolean {
        if (!isActive(request)) return false
        if (request.advancesNextPage) nextPage = request.page + 1
        activeRequestId = null
        return true
    }

    @Synchronized
    fun fail(request: ExplorePageRequest): Boolean {
        if (!isActive(request)) return false
        activeRequestId = null
        return true
    }

    private fun startRequest(page: Int, advancesNextPage: Boolean): ExplorePageRequest {
        val requestId = ++requestSequence
        activeRequestId = requestId
        return ExplorePageRequest(page, requestId, advancesNextPage)
    }
}

internal fun executeDiscoverySelection(input: JsonObject): Map<String, Any> {
    fun int(name: String) = input.get(name).asInt
    fun text(name: String) = input.get(name).asString

    val state = ExplorePaginationState()
    val oldPage = int("initialPage")
    val selectedPage = int("selectedPage")
    state.skipTo(oldPage)
    val oldRequest = state.startNextPage()
    state.skipTo(selectedPage)
    val selectedRequest = state.startNextPage()

    val visibleBooks = mutableListOf<String>()
    var error = ""
    if (state.isActive(selectedRequest)) {
        visibleBooks.add(text("selectedBook"))
        check(state.complete(selectedRequest))
    }
    if (text("oldOutcome") == "success") {
        if (state.isActive(oldRequest)) {
            visibleBooks.add(text("oldBook"))
            state.complete(oldRequest)
        }
    } else if (state.fail(oldRequest)) {
        error = "late discovery request failed"
    }

    return mapOf(
        "selectedPage" to selectedPage,
        "visibleBooks" to visibleBooks,
        "staleResultVisible" to visibleBooks.contains(text("oldBook")),
        "error" to error,
    )
}
