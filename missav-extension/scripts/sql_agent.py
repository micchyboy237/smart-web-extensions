import json
import os
import sqlite3
import sys

import requests

# --- Configuration ---
LLAMA_API_URL = "http://127.0.0.1:8080/completion"
DB_PATH = "/Users/jethroestrada/.cache/chrome_db/missav/chroma_data/chroma.sqlite3"
SCHEMA_PATH = os.path.join(
    os.path.dirname(__file__), "generated", "rag_context", "schema.json"
)

MAX_ITERATIONS = 5
TEMPERATURE = 0.1


class SQLAgent:
    def __init__(self):
        self.conn = sqlite3.connect(DB_PATH)
        self.conn.row_factory = sqlite3.Row
        self.schema = self._load_schema()
        self.memory = []  # Accumulated results

    def _load_schema(self):
        with open(SCHEMA_PATH, "r") as f:
            return json.load(f)

    def get_table_context(self, table_name):
        """Retrieve specific table schema to save tokens"""
        if table_name in self.schema["tables"]:
            return json.dumps(self.schema["tables"][table_name], indent=2)
        return "Table not found."

    def get_full_schema_summary(self):
        """For initial planning"""
        return json.dumps(
            {
                "tables": list(self.schema["tables"].keys()),
                "overview": self.schema["database_overview"],
            },
            indent=2,
        )

    def call_llm(self, prompt, system_prompt="You are a SQLite expert."):
        payload = {
            "prompt": f"<|system|>\n{system_prompt}\n<|end|>\n<|user|>\n{prompt}\n<|end|>\n<|assistant|>",
            "n_predict": 512,
            "temperature": TEMPERATURE,
            "stop": ["<|end|>", "</s>"],
        }
        try:
            resp = requests.post(LLAMA_API_URL, json=payload)
            resp.raise_for_status()
            return resp.json()["content"].strip()
        except Exception as e:
            print(f"[LLM Error] {e}")
            return ""

    def execute_sql(self, query):
        try:
            cursor = self.conn.execute(query)
            columns = [description[0] for description in cursor.description]
            rows = [dict(row) for row in cursor.fetchall()]
            return True, columns, rows
        except Exception as e:
            return False, str(e), []

    def run(self, user_query):
        print(f"\n🕵️  Agent Starting: '{user_query}'")

        # Step 1: Identify relevant tables
        system_plan = f"""
        Database Tables: {list(self.schema["tables"].keys())}
        User Query: {user_query}
        
        List ONLY the table names relevant to this query, separated by commas.
        """
        relevant_tables_str = self.call_llm(user_query, system_plan)
        relevant_tables = [
            t.strip()
            for t in relevant_tables_str.split(",")
            if t.strip() in self.schema["tables"]
        ]

        if not relevant_tables:
            relevant_tables = list(self.schema["tables"].keys())[:3]  # Fallback

        print(f"📂 Relevant Tables: {relevant_tables}")

        # Build Context
        context_parts = []
        for t in relevant_tables:
            context_parts.append(f"--- Table: {t} ---\n{self.get_table_context(t)}")

        schema_context = "\n".join(context_parts)

        accumulated_results = ""

        for i in range(MAX_ITERATIONS):
            print(f"\n🔄 Iteration {i + 1}/{MAX_ITERATIONS}")

            # Step 2: Generate SQL
            sql_prompt = f"""
            Schema Context:
            {schema_context}
            
            Previous Results:
            {accumulated_results if accumulated_results else "None yet."}
            
            User Query: {user_query}
            
            Task: Write a single SQLite SELECT query to answer the user. 
            If previous results are sufficient, reply "DONE".
            Otherwise, provide the SQL query inside ```sql ... ``` blocks.
            """

            response = self.call_llm(sql_prompt)
            print(f"🤖 LLM Response:\n{response[:100]}...")

            if "DONE" in response.upper():
                print("✅ Agent finished.")
                break

            # Extract SQL
            sql_query = response
            if "```sql" in response:
                sql_query = response.split("```sql")[1].split("```")[0].strip()
            elif "```" in response:
                sql_query = response.split("```")[1].split("```")[0].strip()

            # Step 3: Execute
            success, result, data = self.execute_sql(sql_query)

            if success:
                print(f"💾 Executed Successfully. Rows: {len(data)}")
                # Summarize result for next iteration memory
                result_summary = (
                    f"Query: {sql_query}\nResult: {json.dumps(data[:5])}..."
                )
                accumulated_results += result_summary + "\n"
                self.memory.append(data)

                # Simple check: if we have data, we might be done?
                # For complex queries, we let the LLM decide via "DONE"
                if len(data) > 0 and i > 0:
                    # Heuristic: if we got data, ask LLM if it's enough in next loop
                    pass
            else:
                print(f"❌ SQL Error: {result}")
                accumulated_results += f"Error executing {sql_query}: {result}\n"

        return self.memory


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python sql_agent.py 'Your question here'")
        # sys.exit(1)

    query = sys.argv[1]
    agent = SQLAgent()
    results = agent.run(query)

    print("\n🏁 Final Results:")
    for res in results:
        print(json.dumps(res, indent=2))
