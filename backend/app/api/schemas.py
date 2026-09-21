"""Request bodies for the operator API.

Event payloads are deliberately not modelled field by field: the reference
library owns that schema and rejects malformed messages atomically, so the API
forwards the object untouched and returns the library's own explanation.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class CreateRun(BaseModel):
    scenario_key: str = Field(description='Key from the scenario catalogue')
    goal: Literal['priority', 'revenue'] = 'priority'
    planner: str = Field(default='cosmostars')
    title: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)


class AdvanceRequest(BaseModel):
    steps: int | None = Field(default=None, ge=0, description='Number of steps to execute')
    to_step: int | None = Field(default=None, ge=0, description='Stop before this step')


class EventRequest(BaseModel):
    event: dict[str, Any] = Field(description='One message in the case event schema')


class OutageRequest(BaseModel):
    """Manual entry for satellite unavailability, as required by the interface."""

    satellite_ids: list[str] = Field(min_length=1)
    end_step: int = Field(ge=1)
    event_id: str | None = None


class CloseDownlinkRequest(OutageRequest):
    """Manual entry for cancelling ground contacts."""


class GoalRequest(BaseModel):
    goal: Literal['priority', 'revenue']


class ForkRequest(BaseModel):
    title: str | None = None


class VerifyRequest(BaseModel):
    """One saved export in the case result schema, to be recomputed as-is."""

    result: dict[str, Any] = Field(description='Contents of a cosmo-B-ops-result-1.0 file')


class UploadScenario(BaseModel):
    key: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_\-]+$')
    scenario: dict[str, Any]


class OutageSpec(BaseModel):
    satellite_id: str
    start_step: int = Field(ge=0)
    end_step: int = Field(ge=1)


class DeriveScenario(BaseModel):
    """Changes the operator may make to a catalogued scenario before a run.

    Exactly the four the statement names — the initial charge of a satellite,
    the solar power coefficient, the priority of an existing job, a period of
    unavailability — and nothing that would turn conditions into a knob for
    tuning results: powers, prices and model rules stay as shipped.
    """

    initial_soc_pct: dict[str, float] = Field(default_factory=dict)
    solar_multiplier: float | None = Field(default=None, gt=0)
    job_priority: dict[str, int] = Field(default_factory=dict)
    outages: list[OutageSpec] = Field(default_factory=list)
    key: str | None = Field(default=None, min_length=1, max_length=64,
                            pattern=r'^[A-Za-z0-9_\-]+$')
    title: str | None = Field(default=None, max_length=120)
