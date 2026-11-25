import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal


class CircuitBreakerOpenError(RuntimeError):
    """Raised immediately when an upstream dependency circuit is OPEN."""


class LLMBudgetExceededError(RuntimeError):
    """Raised when daily LLM spend exceeds the configured FinOps safety ceiling."""


@dataclass(frozen=True)
class CircuitSnapshot:
    name: str
    state: str
    failure_count: int
    failure_threshold: int
    total_trips: int
    cooldown_remaining_s: float


class CircuitBreaker:
    """
    Thread-safe production circuit breaker (CLOSED -> OPEN -> HALF_OPEN -> CLOSED).
    Prevents cascading stalls when upstream LLMs or n8n edge webhooks degrade.
    """

    def __init__(
        self,
        name: str,
        *,
        failure_threshold: int = 5,
        recovery_timeout_s: float = 30.0,
    ) -> None:
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout_s = recovery_timeout_s
        self._lock = threading.Lock()
        self._state = "CLOSED"
        self._failure_count = 0
        self._opened_at: float | None = None
        self._total_trips = 0

    def allow_request(self) -> None:
        with self._lock:
            if self._state == "CLOSED":
                return
            if self._state == "OPEN":
                elapsed = time.monotonic() - (self._opened_at or 0.0)
                if elapsed >= self.recovery_timeout_s:
                    self._state = "HALF_OPEN"
                    return
                remaining = max(0.0, self.recovery_timeout_s - elapsed)
                raise CircuitBreakerOpenError(f"Circuit '{self.name}' is OPEN; retry in {remaining:.1f}s.")

    def record_success(self) -> None:
        with self._lock:
            self._failure_count = 0
            self._opened_at = None
            self._state = "CLOSED"

    def record_failure(self) -> None:
        with self._lock:
            self._failure_count += 1
            if self._state == "HALF_OPEN" or self._failure_count >= self.failure_threshold:
                if self._state != "OPEN":
                    self._total_trips += 1
                self._state = "OPEN"
                self._opened_at = time.monotonic()

    def reset(self) -> None:
        with self._lock:
            self._state = "CLOSED"
            self._failure_count = 0
            self._opened_at = None

    def snapshot(self) -> CircuitSnapshot:
        with self._lock:
            cooldown = 0.0
            if self._state == "OPEN" and self._opened_at is not None:
                cooldown = max(0.0, self.recovery_timeout_s - (time.monotonic() - self._opened_at))
            return CircuitSnapshot(
                name=self.name,
                state=self._state,
                failure_count=self._failure_count,
                failure_threshold=self.failure_threshold,
                total_trips=self._total_trips,
                cooldown_remaining_s=round(cooldown, 2),
            )


class DailyLLMBudgetGuard:
    """Hard FinOps daily spend ceiling preventing runaway cloud AI bills under burst load."""

    def __init__(self, max_daily_usd: Decimal = Decimal("25.00")) -> None:
        self._lock = threading.Lock()
        self._max_daily_usd = max_daily_usd
        self._current_day = datetime.now(UTC).date()
        self._spent_today = Decimal("0.000000")

    def _roll_day_if_needed(self) -> None:
        today = datetime.now(UTC).date()
        if today != self._current_day:
            self._current_day = today
            self._spent_today = Decimal("0.000000")

    def set_limit(self, max_daily_usd: Decimal) -> None:
        with self._lock:
            self._max_daily_usd = max_daily_usd

    def assert_within_budget(self) -> None:
        with self._lock:
            self._roll_day_if_needed()
            if self._spent_today >= self._max_daily_usd:
                raise LLMBudgetExceededError(
                    f"Daily LLM budget exhausted (${self._spent_today} >= ${self._max_daily_usd})."
                )

    def record_spend(self, cost_usd: Decimal) -> None:
        with self._lock:
            self._roll_day_if_needed()
            self._spent_today += cost_usd

    def reset(self) -> None:
        with self._lock:
            self._current_day = datetime.now(UTC).date()
            self._spent_today = Decimal("0.000000")

    def snapshot(self) -> dict[str, str]:
        with self._lock:
            self._roll_day_if_needed()
            remaining = max(Decimal("0.000000"), self._max_daily_usd - self._spent_today)
            return {
                "utc_date": self._current_day.isoformat(),
                "spent_today_usd": f"{self._spent_today:.6f}",
                "daily_limit_usd": f"{self._max_daily_usd:.2f}",
                "remaining_usd": f"{remaining:.6f}",
            }


gemini_circuit = CircuitBreaker("gemini_llm", failure_threshold=5, recovery_timeout_s=30.0)
n8n_circuit = CircuitBreaker("n8n_edge", failure_threshold=5, recovery_timeout_s=20.0)
llm_budget_guard = DailyLLMBudgetGuard(max_daily_usd=Decimal("25.00"))
