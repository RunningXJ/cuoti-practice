# 云托管用（可选）。本地仍用 start.bat，结构不变。
FROM python:3.10-slim
WORKDIR /app
COPY . .
# Render 会注入 PORT；本地默认 8765
ENV PORT=8765
EXPOSE 8765
CMD ["python", "-u", "server.py"]
