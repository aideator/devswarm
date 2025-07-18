from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import and_, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.core.config import get_settings
from app.core.database import get_session
from app.core.dependencies import CurrentUser
from app.core.deps import get_orchestrator
from app.models.run import Run, RunStatus
from app.models.session import Preference, Session, Turn
from app.schemas.session import (
    CodeRequest,
    CodeResponse,
    PreferenceCreate,
    PreferenceResponse,
    SessionAnalytics,
    SessionCreate,
    SessionExport,
    SessionListResponse,
    SessionResponse,
    SessionUpdate,
    TurnCreate,
    TurnResponse,
)
from app.services.agent_orchestrator import AgentOrchestrator

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _determine_agent_mode(model_definition_id: str, context: str = "") -> str:
    """Determine the appropriate agent mode based on model and context."""
    model_lower = model_definition_id.lower()

    # Check if this is chat mode
    if context and "chat" in context.lower():
        return "chat"

    # Map specific code models to their agent modes
    if "claude" in model_lower or model_definition_id == "claude-code":
        return "claude-cli"
    if "codex" in model_lower or "gpt-4-codex" in model_lower:
        return "openai-codex"
    if "gemini" in model_lower or model_definition_id == "gemini-code":
        return "gemini-cli"

    # Default to litellm for other models
    return "litellm"


@router.get("/", response_model=SessionListResponse)
async def get_sessions(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_session),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    active_only: bool = Query(False),
    archived_only: bool = Query(False),
) -> SessionListResponse:
    """Get user's sessions with pagination."""
    query = select(Session).where(col(Session.user_id) == current_user.id)

    if active_only:
        query = query.where(col(Session.is_active))
    elif archived_only:
        query = query.where(col(Session.is_archived))

    # Get total count
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar()

    # Get sessions with pagination
    query = (
        query.order_by(desc(col(Session.last_activity_at))).offset(skip).limit(limit)
    )
    result = await db.execute(query)
    sessions = result.scalars().all()

    return SessionListResponse(
        sessions=[SessionResponse.model_validate(session) for session in sessions],
        total=total or 0,
        limit=limit,
        offset=skip,
    )


@router.post("/", response_model=SessionResponse)
async def create_session(
    session_data: SessionCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    """Create a new session."""
    session = Session(
        id=str(uuid4()),
        user_id=current_user.id,
        title=session_data.title,
        description=session_data.description,
        models_used=session_data.models_used,
    )

    db.add(session)
    await db.commit()
    await db.refresh(session)

    return SessionResponse.model_validate(session)


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session_by_id(
    session_id: str, current_user: CurrentUser, db: AsyncSession = Depends(get_session)
) -> SessionResponse:
    """Get a specific session."""
    query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    result = await db.execute(query)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return SessionResponse.model_validate(session)


@router.put("/{session_id}", response_model=SessionResponse)
async def update_session(
    session_id: str,
    session_update: SessionUpdate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    """Update a session."""
    query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    result = await db.execute(query)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Update fields
    update_data = session_update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(session, field, value)

    session.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(session)

    return SessionResponse.model_validate(session)


@router.delete("/{session_id}")
async def delete_session(
    session_id: str, current_user: CurrentUser, db: AsyncSession = Depends(get_session)
) -> dict[str, str]:
    """Delete a session."""
    query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    result = await db.execute(query)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    await db.delete(session)
    await db.commit()

    return {"message": "Session deleted successfully"}


@router.get("/{session_id}/turns", response_model=list[TurnResponse])
async def get_session_turns(
    session_id: str, current_user: CurrentUser, db: AsyncSession = Depends(get_session)
) -> list[TurnResponse]:
    """Get all turns for a session."""
    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get turns
    turns_query = (
        select(Turn)
        .where(col(Turn.session_id) == session_id)
        .order_by(col(Turn.turn_number))
    )
    turns_result = await db.execute(turns_query)
    return [TurnResponse.model_validate(turn) for turn in turns_result.scalars().all()]


@router.post("/{session_id}/turns", response_model=TurnResponse)
async def create_turn(
    session_id: str,
    turn_data: TurnCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_session),
) -> TurnResponse:
    """Create a new turn in a session."""
    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get next turn number
    turn_count_query = select(func.count(Turn.id)).where(
        col(Turn.session_id) == session_id
    )
    turn_count_result = await db.execute(turn_count_query)
    turn_number = (turn_count_result.scalar() or 0) + 1

    # Create turn
    turn = Turn(
        id=str(uuid4()),
        session_id=session_id,
        user_id=current_user.id,
        turn_number=turn_number,
        prompt=turn_data.prompt,
        context=turn_data.context,
        models_requested=turn_data.models_requested,
    )

    db.add(turn)

    # Update session
    session.total_turns += 1
    session.last_activity_at = datetime.utcnow()
    session.updated_at = datetime.utcnow()

    await db.commit()
    await db.refresh(turn)

    return TurnResponse.model_validate(turn)


@router.get("/{session_id}/turns/{turn_id}", response_model=TurnResponse)
async def get_turn(
    session_id: str,
    turn_id: str,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_session),
) -> TurnResponse:
    """Get a specific turn."""
    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get turn
    turn_query = select(Turn).where(
        and_(col(Turn.id) == turn_id, col(Turn.session_id) == session_id)
    )
    turn_result = await db.execute(turn_query)
    turn = turn_result.scalar_one_or_none()

    if not turn:
        raise HTTPException(status_code=404, detail="Turn not found")

    return TurnResponse.model_validate(turn)


@router.post(
    "/{session_id}/turns/{turn_id}/preferences", response_model=PreferenceResponse
)
async def create_preference(
    session_id: str,
    turn_id: str,
    preference_data: PreferenceCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_session),
) -> PreferenceResponse:
    """Create a preference for a turn."""
    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Verify turn exists
    turn_query = select(Turn).where(
        and_(col(Turn.id) == turn_id, col(Turn.session_id) == session_id)
    )
    turn_result = await db.execute(turn_query)
    turn = turn_result.scalar_one_or_none()

    if not turn:
        raise HTTPException(status_code=404, detail="Turn not found")

    # Create preference
    preference = Preference(
        id=str(uuid4()),
        user_id=current_user.id,
        session_id=session_id,
        turn_id=turn_id,
        preferred_model=preference_data.preferred_model,
        preferred_response_id=preference_data.preferred_response_id,
        compared_models=preference_data.compared_models,
        response_quality_scores=preference_data.response_quality_scores,
        feedback_text=preference_data.feedback_text,
        confidence_score=preference_data.confidence_score,
        preference_type=preference_data.preference_type,
    )

    db.add(preference)

    # Update session activity
    session.last_activity_at = datetime.utcnow()
    session.updated_at = datetime.utcnow()

    await db.commit()
    await db.refresh(preference)

    return PreferenceResponse.model_validate(preference)


@router.get("/{session_id}/preferences", response_model=list[PreferenceResponse])
async def get_session_preferences(
    session_id: str, current_user: CurrentUser, db: AsyncSession = Depends(get_session)
) -> list[PreferenceResponse]:
    """Get all preferences for a session."""
    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get preferences
    preferences_query = (
        select(Preference)
        .where(col(Preference.session_id) == session_id)
        .order_by(col(Preference.created_at))
    )
    preferences_result = await db.execute(preferences_query)
    return [
        PreferenceResponse.model_validate(pref)
        for pref in preferences_result.scalars().all()
    ]


@router.get("/{session_id}/analytics", response_model=SessionAnalytics)
async def get_session_analytics(
    session_id: str, current_user: CurrentUser, db: AsyncSession = Depends(get_session)
) -> SessionAnalytics:
    """Get analytics for a specific session."""
    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get session analytics
    turns_query = select(Turn).where(col(Turn.session_id) == session_id)
    turns_result = await db.execute(turns_query)
    turns = turns_result.scalars().all()

    preferences_query = select(Preference).where(
        col(Preference.session_id) == session_id
    )
    preferences_result = await db.execute(preferences_query)
    preferences = preferences_result.scalars().all()

    # Calculate analytics
    total_cost = sum(turn.total_cost for turn in turns)
    models_used = session.models_used

    # Model preference stats
    model_wins = {}
    for pref in preferences:
        model_wins[pref.preferred_model] = model_wins.get(pref.preferred_model, 0) + 1

    model_preference_stats = {}
    for model in models_used:
        model_preference_stats[model] = {
            "wins": model_wins.get(model, 0),
            "win_rate": model_wins.get(model, 0) / len(preferences)
            if preferences
            else 0,
        }

    return SessionAnalytics(
        total_sessions=1,
        active_sessions=1 if session.is_active else 0,
        archived_sessions=1 if session.is_archived else 0,
        total_turns=len(turns),
        total_cost=total_cost,
        average_cost_per_session=total_cost,
        average_turns_per_session=len(turns),
        most_used_models=[{"model": model, "usage": 1} for model in models_used],
        model_preference_stats=model_preference_stats,
    )


@router.get("/{session_id}/export", response_model=SessionExport)
async def export_session(
    session_id: str,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_session),
    export_format: str = Query("json", pattern="^(json|markdown|csv)$"),
) -> SessionExport:
    """Export a session with all its data."""
    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get turns
    turns_query = (
        select(Turn)
        .where(col(Turn.session_id) == session_id)
        .order_by(col(Turn.turn_number))
    )
    turns_result = await db.execute(turns_query)
    turns = turns_result.scalars().all()

    # Get preferences
    preferences_query = select(Preference).where(
        col(Preference.session_id) == session_id
    )
    preferences_result = await db.execute(preferences_query)
    preferences = preferences_result.scalars().all()

    return SessionExport(
        session=SessionResponse.model_validate(session),
        turns=[TurnResponse.model_validate(turn) for turn in turns],
        preferences=[PreferenceResponse.model_validate(pref) for pref in preferences],
        export_format=export_format,
    )


@router.get("/{session_id}/turns/{turn_id}/runs")
async def get_turn_runs(
    session_id: str,
    turn_id: str,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_session),
) -> list[Run]:
    """Get all runs for a specific turn."""
    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Verify turn exists
    turn_query = select(Turn).where(
        and_(col(Turn.id) == turn_id, col(Turn.session_id) == session_id)
    )
    turn_result = await db.execute(turn_query)
    turn = turn_result.scalar_one_or_none()

    if not turn:
        raise HTTPException(status_code=404, detail="Turn not found")

    # Get runs for this turn
    runs_query = (
        select(Run)
        .where(and_(col(Run.turn_id) == turn_id, col(Run.session_id) == session_id))
        .order_by(col(Run.created_at))
    )
    runs_result = await db.execute(runs_query)
    return runs_result.scalars().all()


@router.post("/{session_id}/turns/{turn_id}/code", response_model=CodeResponse)
async def execute_code(
    session_id: str,
    turn_id: str,
    request: CodeRequest,
    background_tasks: BackgroundTasks,
    current_user: CurrentUser,
    orchestrator: AgentOrchestrator = Depends(get_orchestrator),
    db: AsyncSession = Depends(get_session),
) -> CodeResponse:
    """
    Execute code with the specified models for a given turn.

    This endpoint kicks off agent jobs for coding tasks and returns
    streaming URLs for both parsed results and debug logs.
    """
    settings = get_settings()

    # Log the incoming request
    from app.core.logging import get_logger

    logger = get_logger(__name__)

    # Process model variants
    models_to_use = [
        variant.model_definition_id
        for variant in request.model_variants[: request.max_models]
    ]
    model_variants_config = [
        {
            "model_definition_id": variant.model_definition_id,
            "model_parameters": variant.model_parameters,
            "variant_id": variant.id,
            "agent_mode": _determine_agent_mode(
                variant.model_definition_id, request.context or ""
            ),
        }
        for variant in request.model_variants[: request.max_models]
    ]
    logger.info(
        f"Execute code request - using {len(model_variants_config)} model variants"
    )

    # Verify session ownership
    session_query = select(Session).where(
        and_(col(Session.id) == session_id, col(Session.user_id) == current_user.id)
    )
    session_result = await db.execute(session_query)
    session = session_result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Verify turn exists and belongs to session
    turn_query = select(Turn).where(
        and_(col(Turn.id) == turn_id, col(Turn.session_id) == session_id)
    )
    turn_result = await db.execute(turn_query)
    turn = turn_result.scalar_one_or_none()

    if not turn:
        raise HTTPException(status_code=404, detail="Turn not found")

    # Update turn with new prompt if provided
    if turn.prompt != request.prompt:
        turn.prompt = request.prompt
        turn.context = request.context
        turn.models_requested = models_to_use
        turn.status = "streaming"

    # Generate run ID for the coding job
    run_id = f"run-{uuid4().hex}"

    # Create run record
    run = Run(
        id=run_id,
        github_url=request.context
        or "https://github.com/temp/repo",  # Placeholder for now
        prompt=request.prompt,
        variations=len(models_to_use),
        agent_config={
            "model_variants": model_variants_config,
            "use_claude_code": True,
            "agent_mode": model_variants_config[0]["agent_mode"]
            if model_variants_config
            else "code",
        },
        user_id=current_user.id,
        session_id=session_id,
        turn_id=turn_id,
        status=RunStatus.PENDING,
    )

    db.add(run)

    # Update session
    session.last_activity_at = datetime.utcnow()
    session.updated_at = datetime.utcnow()

    await db.commit()
    await db.refresh(run)  # Ensure run is fully loaded with all fields

    # Schedule background orchestration for coding task
    # Using secure API key retrieval system
    # Create a new session for the background task
    from app.core.database import async_session_maker

    async def execute_with_session():
        async with async_session_maker() as session:
            await orchestrator.execute_variations(
                run_id=run_id,
                repo_url=request.context or "https://github.com/temp/repo",
                prompt=request.prompt,
                variations=len(models_to_use),
                user_id=current_user.id,  # Add user_id for secure API key retrieval
                agent_config=None,  # Config is stored in run record
                agent_mode=model_variants_config[0]["agent_mode"]
                if model_variants_config
                else "code",
                db_session=session,
            )

    background_tasks.add_task(execute_with_session)

    # Return response with streaming URLs
    # Use localhost for frontend WebSocket connections instead of 0.0.0.0
    base_url = f"localhost:{settings.port}"
    websocket_url = f"ws://{base_url}{settings.api_v1_prefix}/ws/runs/{run_id}"
    debug_websocket_url = (
        f"ws://{base_url}{settings.api_v1_prefix}/ws/runs/{run_id}/debug"
    )

    return CodeResponse(
        turn_id=turn_id,
        run_id=run_id,
        websocket_url=websocket_url,
        debug_websocket_url=debug_websocket_url,
        status="accepted",
        models_used=models_to_use,
    )
