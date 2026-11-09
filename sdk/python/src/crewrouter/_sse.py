from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Iterable, Iterator, Optional

import httpx

from .errors import CrewRouterStreamError


@dataclass
class StreamEvent:
    event: Optional[str]
    data: str
    parsed: Any
    done: bool


def _try_parse(data: str) -> Any:
    try:
        return json.loads(data)
    except Exception:
        return data


class SSEParser:
    """Incremental SSE parser shared by sync and async streams."""

    def __init__(self) -> None:
        self._event: Optional[str] = None
        self._data: list[str] = []
        self._done = False

    def feed(self, raw_line: str) -> list[StreamEvent]:
        if self._done:
            return []
        line = raw_line
        if line.endswith("\n"):
            line = line[:-1]
        if line.endswith("\r"):
            line = line[:-1]

        if line == "":
            if not self._data:
                self._event = None
                return []
            data = "\n".join(self._data)
            event = StreamEvent(self._event, data, _try_parse(data), data == "[DONE]")
            self._event = None
            self._data = []
            if event.done:
                self._done = True
            return [event]

        if line.startswith(":"):
            return []

        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "event":
            self._event = value
        elif field == "data":
            self._data.append(value)
        return []

    def flush(self) -> list[StreamEvent]:
        if self._done or not self._data:
            return []
        data = "\n".join(self._data)
        event = StreamEvent(self._event, data, _try_parse(data), data == "[DONE]")
        self._event = None
        self._data = []
        if event.done:
            self._done = True
        return [event]


class Stream:
    """Synchronous streaming response context manager."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self._parser = SSEParser()
        self._closed = False

    @property
    def response(self) -> httpx.Response:
        return self._response

    def __iter__(self) -> Iterator[StreamEvent]:
        try:
            for line in self._response.iter_lines():
                for event in self._parser.feed(line):
                    yield event
                    if event.done:
                        return
            for event in self._parser.flush():
                yield event
        except CrewRouterStreamError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalize transport errors
            raise CrewRouterStreamError(f"Stream failed: {exc}") from exc
        finally:
            self.close()

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._response.close()

    def __enter__(self) -> "Stream":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


class AsyncStream:
    """Asynchronous streaming response context manager."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self._parser = SSEParser()
        self._closed = False

    @property
    def response(self) -> httpx.Response:
        return self._response

    async def __aiter__(self) -> AsyncIterator[StreamEvent]:
        try:
            async for line in self._response.aiter_lines():
                for event in self._parser.feed(line):
                    yield event
                    if event.done:
                        return
            for event in self._parser.flush():
                yield event
        except CrewRouterStreamError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise CrewRouterStreamError(f"Stream failed: {exc}") from exc
        finally:
            await self.aclose()

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            await self._response.aclose()

    async def __aenter__(self) -> "AsyncStream":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()


class AsyncStreamRequest:
    """Awaitable async context manager returned by async stream helpers.

    Usage:
        async with client.gateway.chat.completions.stream(body) as stream:
            async for event in stream:
                ...
    """

    def __init__(self, awaitable: Awaitable[AsyncStream]) -> None:
        self._awaitable = awaitable
        self._stream: Optional[AsyncStream] = None

    async def __aenter__(self) -> AsyncStream:
        self._stream = await self._awaitable
        return self._stream

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._stream is not None:
            await self._stream.aclose()


def parse_lines(lines: Iterable[str]) -> Iterator[StreamEvent]:
    parser = SSEParser()
    for line in lines:
        for event in parser.feed(line):
            yield event
            if event.done:
                return
    for event in parser.flush():
        yield event
