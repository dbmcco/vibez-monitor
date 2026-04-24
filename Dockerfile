FROM nikolaik/python-nodejs:python3.12-nodejs20

WORKDIR /app

COPY backend ./backend
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir -e ./backend

COPY config ./config
COPY dashboard ./dashboard
RUN cd dashboard \
  && npm ci \
  && npm run build

COPY scripts ./scripts
RUN chmod +x ./scripts/railway-start.sh

ENV NODE_ENV=production

EXPOSE 3000

CMD ["./scripts/railway-start.sh"]
