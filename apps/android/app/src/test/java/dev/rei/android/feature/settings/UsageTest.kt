package dev.rei.android.feature.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

    private fun totals(processed: Long?, input: Long? = processed, output: Long? = 0, calls: Long = 1) = UsageTotals(
        Metric(input), Metric(0), Metric(input), Metric(output), Metric(processed), calls, 0, null,
    )

    @Test fun metricsReadAsTheWebDoes() {
        assertEquals("1.2K", Metric(1_234).text)
        assertEquals("≥1.2K", Metric(1_234, lowerBound = true).text)
        assertEquals("Unavailable", Metric(null).text)
        assertEquals("0", Metric(0).text)
    }

    @Test fun totalsMarkLowerBoundsWhereCallsDidNotReport() {
        val parsed = json(
            """{"modelCalls":12,"callsUnreported":2,"cacheHitPercent":60,"tokens":{"inputTotal":3400,"outputTotal":900,"totalProcessed":4300},"unknown":{"inputTotal":2,"outputTotal":0}}""",
        ).usageTotals()
        assertEquals("≥3.4K", parsed.inputTotal.text)
        assertEquals("900", parsed.outputTotal.text)
        assertEquals("Unavailable", parsed.inputCached.text)
        assertEquals(12L, parsed.calls)
        assertEquals(2L, parsed.callsUnreported)
        assertEquals("60.0%", cacheHitText(parsed.cacheHitPercent))
        assertEquals("Unavailable", cacheHitText(null))
    }

    @Test fun barsAreSharesOfTheLargestRow() {
        val rows = listOf(UsageRow("a", totals(1000)), UsageRow("b", totals(250)), UsageRow("c", totals(0)), UsageRow("d", totals(1)))
        val bars = shares(rows)
        assertEquals(1f, bars[0], 0.0001f)
        assertEquals(0.25f, bars[1], 0.0001f)
        assertEquals(0f, bars[2], 0f)
        assertEquals(0.02f, bars[3], 0.0001f)
        assertEquals(listOf(0f), shares(listOf(UsageRow("z", totals(0)))))
        assertTrue(shares(emptyList()).isEmpty())
    }

    @Test fun barsFallBackToInputPlusOutputWhenTotalIsMissing() {
        val row = UsageRow("a", totals(processed = null, input = 300, output = 200))
        assertEquals(500L, row.weight)
    }

    @Test fun parsesTheUsageAnswer() {
        val data = usageData(
            json(
                """{"period":"30d","from":"2026-01-01","to":"2026-01-30","trackingSince":"2025-12-20T00:00:00Z",
                "summary":{"modelCalls":3,"tokens":{"totalProcessed":4000}},
                "byPurpose":[{"purpose":"agent_task","usage":{"modelCalls":1,"tokens":{"totalProcessed":10}}}],
                "byModel":[{"providerName":"Acme","model":"big-1","usage":{"modelCalls":2,"tokens":{"totalProcessed":3990}}}],
                "byAgent":[{"agentId":null,"usage":{"modelCalls":1}},{"agentId":"a1","usage":{"modelCalls":1}},{"agentId":"gone","usage":{"modelCalls":1}}],
                "daily":[{"day":"2026-01-02","usage":{"modelCalls":3,"tokens":{"totalProcessed":4000}}}]}""",
            ),
            mapOf("a1" to "Scout"),
        )
        assertEquals("2025-12-20", data.trackingSince)
        assertEquals("4K", data.summary.totalProcessed.text)
        assertEquals("Agent tasks", data.byPurpose.single().label)
        assertEquals("Acme / big-1", data.byModel.single().label)
        assertEquals(listOf("Unassigned", "Scout", "gone"), data.byAgent.map { it.label })
        assertEquals("2026-01-02", data.daily.single().label)
        assertNull(data.search)
    }

    @Test fun emptyAnswersNameTheirPeriod() {
        val base = usageData(json("""{"period":"7d","from":"2026-01-01","to":"2026-01-07","trackingSince":"2025-12-20"}"""), emptyMap())
        assertEquals("No usage recorded in this period", emptyUsageMessage(base))
        assertEquals("No usage recorded since tracking began", emptyUsageMessage(base.copy(period = "all")))
        assertEquals("No usage recorded since tracking began", emptyUsageMessage(base.copy(from = "2025-12-20")))
    }

    @Test fun searchUsageCountsAttemptsAndExplainsProblems() {
        val search = json(
            """{"searches":10,"answered":7,"empty":2,"failed":1,"searchesWithFallback":3,
            "byProvider":[{"providerName":"Finder","succeeded":7,"empty":2,"failed":1,"skipped":4,"fallback":3,"answeredAfterFallback":2,"averageMs":1234.5,
            "details":[{"outcome":"succeeded","calls":7},{"outcome":"failed","reason":"search_timeout","fallback":true,"calls":1},{"outcome":"skipped","reason":"not_configured","calls":4}]}]}""",
        ).searchUsage()
        assertEquals(10L, search.searches)
        assertEquals(3L, search.withFallback)
        val provider = search.providers.single()
        assertEquals(10L, provider.searched)
        assertEquals(listOf("Failed · timed out (as fallback)", "Skipped · not configured"), provider.problems.map(::searchDetailLabel))
        assertEquals("1,234.5 ms", averageText(provider.averageMs))
        assertEquals("—", averageText(null))
        assertEquals("some odd reason", searchReason("some_odd_reason"))
    }

    @Test fun customRangesAreChecked() {
        assertEquals("Choose both dates to see usage.", rangeProblem("", "2026-01-02"))
        assertEquals("The To date must be on or after the From date.", rangeProblem("2026-01-03", "2026-01-02"))
        assertNull(rangeProblem("2026-01-02", "2026-01-02"))
    }

    @Test fun onlyCustomQueriesCarryDates() {
        assertEquals(mapOf("period" to "7d"), usageQuery("7d", "2026-01-01", "2026-01-02"))
        assertEquals(mapOf("period" to "custom", "from" to "2026-01-01", "to" to "2026-01-02"), usageQuery("custom", "2026-01-01", "2026-01-02"))
    }

    @Test fun daysAreUtc() {
        val millis = utcDayMillis("2026-03-05")!!
        assertEquals("2026-03-05", utcDay(millis))
        assertEquals("2026-03-05", utcDay(millis + 86_399_999))
        assertEquals("2026-03-06", utcDay(millis + 86_400_000))
        assertNull(utcDayMillis("not a date"))
        assertEquals("2026-02-04" to "2026-03-05", defaultRange(millis))
    }
}
