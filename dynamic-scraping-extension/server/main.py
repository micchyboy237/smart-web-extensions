# server/main.py

from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from jet.libs.smolagents.utils.model_utils import create_local_model
from jet.logger import logger
from smolagents import (
    CodeAgent,
    tool,
)

app = FastAPI(title="LLM → Chrome JS Code Generator")

# -------------------------------
#   Custom Tools for agents
# -------------------------------


@tool
def format_javascript_template(template: str, variables: Dict[str, Any]) -> str:
    """Safely format a JavaScript code template string using provided variables.

    This tool is used to insert dynamic values into JS code snippets without
    risking syntax errors from manual string concatenation.

    Args:
        template: The JavaScript code template containing {placeholder} fields.
                  Example: "console.log('{message}');"
        variables: Dictionary mapping placeholder names to their values.
                   Values are converted to strings automatically.

    Returns:
        The formatted JavaScript code as a string.
        If formatting fails, returns a comment with the error message.
    """
    try:
        return template.format(**variables)
    except Exception as e:
        return f"// Error in template formatting: {str(e)}"


@tool
def validate_dom_selector(selector: str) -> str:
    """Check a proposed CSS selector for obviously dangerous patterns.

    This is a basic safety check before injecting user/LLM-generated selectors
    into document.querySelectorAll() or similar calls.

    Args:
        selector: The CSS selector string to validate.
                  Example: "video[src^='https://']", ".thumbnail img"

    Returns:
        The original selector if it looks safe.
        A comment string starting with "// WARNING: ..." if suspicious patterns
        are detected (e.g. contains eval, innerHTML assignment, etc.).
    """
    dangerous = ["document.write", "eval(", "innerHTML=", "location.href"]
    if any(d in selector.lower() for d in dangerous):
        return f"// WARNING: potentially unsafe selector: {selector}"
    return selector


@app.post("/generate")
async def generate_js_code(body: Dict[str, str]):
    user_query = body.get("query", "").strip()
    if not user_query:
        raise HTTPException(400, "Missing 'query' field")

    try:
        model = create_local_model()

        # Coder sub-agent: focused on generating clean JS
        coder_agent = CodeAgent(
            model=model,
            tools=[],  # pure generation, no tool calls needed
            max_steps=10,
            name="js_generator",
            description=(
                "Specialized agent for generating safe, modern JavaScript code "
                "that runs in the browser MAIN world for Chrome extensions. "
                "Input will be a user request + plan/reasoning. "
                "Output ONLY the raw JavaScript code inside an IIFE: "
                "(function() { ... })(); "
                "Focus: DOM querying (querySelectorAll), collecting media elements, "
                "building floating UI/panel or new window, click handlers for scrollIntoView, "
                "try/catch everywhere, no dependencies, ES6+."
            ),
        )

        # Manager agent: orchestrates planning and delegates to coder
        manager_agent = CodeAgent(
            model=model,
            tools=[format_javascript_template, validate_dom_selector],
            managed_agents=[coder_agent],
            max_steps=20,
            name="manager",
            description="Top-level coordinator. Plan step-by-step, use tools if needed, then delegate to js_generator with full context when ready to produce code.",
            code_block_tags=("```python", "```"),
        )

        result = manager_agent.run(user_query)
        generated_js = str(result).strip()  # final output should be the JS string

        # Safety wrapper (same as before)
        wrapped_js = f"""
        (function() {{
            try {{
                {generated_js}
            }} catch (err) {{
                console.error("Generated script failed:", err);
                // Optional: show error in page if you want
            }}
        }})();
        """

        return {"javascript": wrapped_js}

    except Exception as e:
        raise HTTPException(500, f"Agent failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting summarizer server on http://localhost:8001")
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8001,
    )
