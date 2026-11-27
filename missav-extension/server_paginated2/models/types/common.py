from typing import List, Literal, Optional, Union

GenreCodeInput = Optional[Union[str, List[str]]]
CompletionFilter = Literal["all", "complete", "incomplete"]
VideoSearchMode = Literal["fts", "semantic", "hybrid"]
