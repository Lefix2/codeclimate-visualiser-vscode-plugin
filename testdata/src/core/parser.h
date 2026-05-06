#ifndef PARSER_H
#define PARSER_H

#include <stddef.h>

#define MAX_TOKENS  100
#define BUFFER_SIZE 1024

typedef struct
{
    char  type[32];
    char  value[256];
    int   line;
    int   column;
} Token;

typedef struct
{
    Token tokens[MAX_TOKENS];
    int   count;
    char *source;
    int   capacity;
} Parser;

extern Parser *g_parser;

void  parser_init(Parser *p, const char *src, size_t len);
Token parser_next(Parser *p);
int   parser_peek(Parser *p);
void  parser_reset(Parser *p);
void  parser_free(Parser *p);

#endif /* PARSER_H */
