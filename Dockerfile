# 云托管用（可选）。本地仍用 start.bat，结构不变。
FROM python:3.10-slim
WORKDIR /app
COPY . .
ENV PORT=8765
EXPOSE 8765
CMD ["python", "server.py"]
