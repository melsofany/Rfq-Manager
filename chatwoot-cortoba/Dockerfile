# Cortoba's overlay onto upstream Chatwoot.
#
# We do NOT build Chatwoot from source: the container is the official published
# image, pinned to the SAME release that is vendored in ../chatwoot (see
# ../chatwoot/UPSTREAM.md). This image only adds our integration files, so an
# upstream bump is a one-line change of the tag below.
FROM chatwoot/chatwoot:v4.19.1

# Our overlay: one initializer (console configuration) + the service objects it
# loads. Nothing in /app is modified, so the upstream tree stays untouched and
# the overlay is reviewable as a small, self-contained addition.
COPY config/initializers/cortoba.rb /app/config/initializers/cortoba.rb
COPY lib/cortoba.rb /app/lib/cortoba.rb
COPY lib/cortoba/ /app/lib/cortoba/
COPY lib/tasks/cortoba.rake /app/lib/tasks/cortoba.rake
